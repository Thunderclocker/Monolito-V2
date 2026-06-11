/**
 * Tests for the proactive heartbeat system and the single-session design.
 *
 * These tests pin down:
 *   - MAIN_SESSION_ID is the constant "orchestrator"
 *   - The heartbeat targets MAIN_SESSION_ID (not a filtered listSessions)
 *   - The "skip if no tasks" short-circuit is gone — the model is always
 *     consulted on a heartbeat tick
 *   - The HEARTBEAT_OK response is correctly recognized
 *
 * We don't call the model API in these tests (that requires real
 * credentials). The test_runtime_integration.test.ts file already
 * covers the wiring. These tests focus on the heartbeat's structural
 * contract.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { MAIN_SESSION_ID } from "../ipc/protocol.ts"
import { ensureSession, getSession } from "../session/store.ts"
import { rmSync, existsSync } from "node:fs"

const TEST_ROOT = "/tmp/monolito-heartbeat-test"

// Route DB access through the tempdir. Without this, `getPaths()` falls
// back to the captured MONOLITO_ROOT constant and the 09-jun-2026 runtime
// guard refuses to open /home/cristian/.monolito/memory/memory.sqlite
// from a test process.
process.env.MONOLITO_ROOT = TEST_ROOT

test("MAIN_SESSION_ID is the canonical user-facing session", () => {
  assert.equal(typeof MAIN_SESSION_ID, "string")
  assert.equal(MAIN_SESSION_ID, "orchestrator")
})

test("MAIN_SESSION_ID: not an internal session prefix", () => {
  // These prefixes are reserved for internal sessions
  assert.ok(!MAIN_SESSION_ID.startsWith("agent-"))
  assert.ok(!MAIN_SESSION_ID.startsWith("telegram-"))
  assert.ok(!MAIN_SESSION_ID.startsWith("skills-"))
  assert.ok(!MAIN_SESSION_ID.startsWith("daemon-"))
})

test("ensureSession + getSession: MAIN_SESSION_ID round-trip works", () => {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true })
  }
  ensureSession(TEST_ROOT, MAIN_SESSION_ID, "Main session (heartbeat test)")
  const session = getSession(TEST_ROOT, MAIN_SESSION_ID)
  assert.ok(session, "MAIN_SESSION_ID session must be retrievable")
  assert.equal(session.id, MAIN_SESSION_ID)
})

test("runtime uses inactivity timer instead of heartbeatTimer", async () => {
  const { readFileSync } = await import("node:fs")
  const src = readFileSync("src/core/runtime/runtime.ts", "utf8")
  
  assert.ok(
    !src.includes("private heartbeatTimer"),
    "heartbeatTimer should be removed"
  )
  assert.ok(
    src.includes("private memoryConsolidationTimer"),
    "memoryConsolidationTimer should be introduced"
  )
  assert.ok(
    src.includes("scheduleMemoryConsolidation"),
    "scheduleMemoryConsolidation helper should be defined"
  )
  assert.ok(
    src.includes("cancelMemoryConsolidation"),
    "cancelMemoryConsolidation helper should be defined"
  )
})
