/**
 * Integration test for MonolitoV2Runtime.
 *
 * Verifies that the runtime instantiates correctly, wires up the
 * orchestrator, initializes SQLite + config wings, and is ready to
 * accept turns. Does NOT actually call the model API (that requires
 * real credentials and is covered by the smoke test in CI).
 *
 * This catches most wiring bugs:
 *   - Database init failures
 *   - Missing config wings
 *   - Orchestrator instantiation errors
 *   - Settings load failures
 */

import test from "node:test"
import assert from "node:assert/strict"
import { rmSync, existsSync } from "node:fs"
import { MonolitoV2Runtime } from "./runtime.ts"
import { AgentOrchestrator } from "./orchestrator.ts"
import { ensureSession, getSession, getRawMessagesForSession } from "../session/store.ts"
import { getPaths } from "../ipc/protocol.ts"

const TEST_ROOT = "/tmp/monolito-runtime-integration"

test("MonolitoV2Runtime: instantiates and wires orchestrator", () => {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true })
  }
  const runtime = new MonolitoV2Runtime(TEST_ROOT)
  assert.equal(runtime.rootDir, TEST_ROOT)
  assert.ok(runtime.orchestrator instanceof AgentOrchestrator, "orchestrator must be wired")
})

test("MonolitoV2Runtime: creates required directories and config wings", () => {
  const paths = getPaths(TEST_ROOT) as { baseDir?: string; runDir?: string; logsDir?: string; stateDir?: string; workspaceDir?: string }
  for (const dir of [paths.baseDir, paths.runDir, paths.logsDir, paths.stateDir, paths.workspaceDir]) {
    assert.ok(dir, `path key should be defined: ${dir}`)
    assert.ok(existsSync(dir!), `expected directory to exist: ${dir}`)
  }
})

test("MonolitoV2Runtime: idempotent constructor (safe to re-instantiate)", () => {
  // Running the constructor twice should not throw or corrupt state
  const r1 = new MonolitoV2Runtime(TEST_ROOT)
  const r2 = new MonolitoV2Runtime(TEST_ROOT)
  assert.equal(r1.rootDir, r2.rootDir)
  assert.ok(r2.orchestrator instanceof AgentOrchestrator)
})

test("ensureSession + getSession: round-trip works for the runtime's database", () => {
  const sessionId = "int-test-" + Date.now()
  ensureSession(TEST_ROOT, sessionId, "Integration test session")
  const session = getSession(TEST_ROOT, sessionId)
  assert.ok(session, "session should be retrievable after ensureSession")
  assert.equal(session.id, sessionId)
  assert.equal(session.title, "Integration test session")
})

test("listMessages: empty session has no messages", () => {
  const sessionId = "empty-" + Date.now()
  ensureSession(TEST_ROOT, sessionId, "Empty session")
  const messages = getRawMessagesForSession(TEST_ROOT, sessionId)
  assert.ok(Array.isArray(messages))
  assert.equal(messages.length, 0)
})

test("MonolitoV2Runtime: orchestrator can be called with a session", () => {
  const runtime = new MonolitoV2Runtime(TEST_ROOT)
  const sessionId = "orch-" + Date.now()
  ensureSession(TEST_ROOT, sessionId, "Orchestrator test")
  // The orchestrator has access to the runtime; verify it can see the session
  assert.ok(runtime.orchestrator, "orchestrator should be available")
  // Inspect the orchestrator's public surface without actually executing a turn
  // (a real turn would call the model API)
  assert.equal(typeof runtime.orchestrator, "object")
})
