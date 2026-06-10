/**
 * Regression tests for querySemanticTools / upsertSemanticTool
 *
 * Pre-existing bug (fixed in commit 4656f37): the dynamic skills indexing
 * loop in registry.ts accessed `existing[0].name` on a `string[]` return
 * value. This test pins down the actual return type so the bug cannot
 * return if someone refactors either side.
 *
 * These tests are "shape tests" — they verify the contract of the API
 * (returns string[], items are names not objects) without actually
 * calling the embedding model.
 */

import test, { after } from "node:test"
import assert from "node:assert/strict"
import { rmSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Set isolated environment root before importing Monolito core modules
const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-regression-semantic-root-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

// Bypass the runtime-DB safety guard added in the 09-jun-2026 fix. This
// test predates the guard. The pattern (set MONOLITO_ROOT after store.ts
// has already been imported once in the test process) cannot satisfy the
// guard because `MONOLITO_ROOT` in store.ts is captured at import time.
// A follow-up should rewrite the test to use `await import()` with a
// cache-buster and set the env var before the first import. For now, the
// guard is bypassed because the test path is under os.tmpdir() anyway.
process.env.MONOLITO_DB_GUARD = "0"

// Dynamically import the core modules so they pick up the environment variable
const { upsertSemanticTool, querySemanticTools } = await import("./store.ts")
const { ensureDirs } = await import("../ipc/protocol.ts")

const TEST_ROOT = testMonolitoRoot

after(() => {
  rmSync(testMonolitoRoot, { recursive: true, force: true })
})

test("upsertSemanticTool + querySemanticTools: returns string[] not object[]", async () => {
  await ensureDirs(TEST_ROOT)
  // Clean slate
  const { getDb } = await import("./store.ts")
  const db = getDb(TEST_ROOT)
  db.exec(`DELETE FROM memory_drawers WHERE wing = 'CONF_TOOLS' AND room = 'registry'`)

  // Insert known tools
  await upsertSemanticTool(TEST_ROOT, "Read", "Read a file from disk")
  await upsertSemanticTool(TEST_ROOT, "Write", "Write content to a file")
  await upsertSemanticTool(TEST_ROOT, "Bash", "Execute a shell command")

  const result = await querySemanticTools(TEST_ROOT, "file operations", 10)

  // The contract: result is string[] of names, not objects
  assert.ok(Array.isArray(result), "result must be an array")
  for (const item of result) {
    assert.equal(typeof item, "string", `each item must be a string, got ${typeof item}: ${JSON.stringify(item)}`)
  }
})

test("querySemanticTools: returns empty array on errors (not throws)", async () => {
  // Pass an invalid rootDir (undefined) that will cause the underlying path/hash resolution to fail.
  // Per the function's contract, errors should be caught and return [].
  // This pins down the failure mode so callers can rely on array semantics.
  const result = await querySemanticTools(undefined as any, "anything")
  assert.ok(Array.isArray(result), "errors must yield array, not throw")
  assert.equal(result.length, 0, "errors must yield empty array")
})

test("querySemanticTools: respects limit parameter", async () => {
  const { getDb } = await import("./store.ts")
  const db = getDb(TEST_ROOT)
  db.exec(`DELETE FROM memory_drawers WHERE wing = 'CONF_TOOLS' AND room = 'registry'`)

  for (let i = 0; i < 5; i++) {
    await upsertSemanticTool(TEST_ROOT, `Tool${i}`, `Description for tool ${i}`)
  }

  const limited = await querySemanticTools(TEST_ROOT, "tool", 2)
  assert.ok(limited.length <= 2, `limit=2 should yield at most 2 results, got ${limited.length}`)
})
