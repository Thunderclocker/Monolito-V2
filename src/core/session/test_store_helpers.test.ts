/**
 * Tests for store.ts session helpers.
 *
 * store.ts is the second-largest file in the codebase (~2400 lines after
 * the worker/delegation removal) and owns all file-backed storage access. The pure
 * helpers (no I/O) are tested here. Persistence-backed functions use temp dirs
 * in integration tests.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { isMainSession } from "./store.ts"

// Mirror of the internal const. Kept in sync by test_pairing_with_store.
// After the worker/delegation removal, "worker-" is no longer a session
// prefix — the only reserved worker prefix is "agent-", kept as a
// defense-in-depth check (no caller creates agent-* sessions anymore).
const WORKER_SESSION_PREFIXES = ["agent-"] as const

test("isMainSession: returns true for plain session IDs", () => {
  assert.equal(isMainSession("main"), true)
  assert.equal(isMainSession("user-123"), true)
  assert.equal(isMainSession("default"), true)
})

test("isMainSession: returns true for empty-ish session IDs", () => {
  // Edge case: empty string doesn't start with any prefix
  assert.equal(isMainSession(""), true)
})

test("isMainSession: returns false for worker session IDs", () => {
  for (const prefix of WORKER_SESSION_PREFIXES) {
    const workerId = `${prefix}abc123`
    assert.equal(isMainSession(workerId), false, `prefix ${prefix} should mark as worker`)
  }
})

test("isMainSession: prefix matching is anchored at start, not substring", () => {
  // If a session ID happens to contain the prefix as a substring,
  // it's still considered a main session
  for (const prefix of WORKER_SESSION_PREFIXES) {
    const containsId = `main-${prefix}-xyz`
    assert.equal(isMainSession(containsId), true, `substring ${prefix} should not match`)
  }
})
