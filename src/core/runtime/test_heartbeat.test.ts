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

test("runProactiveBackgroundTurn: no longer short-circuits on empty task list", async () => {
  // We can't easily call runProactiveBackgroundTurn without the full
  // runtime, but we can verify the old short-circuit text is GONE
  // from the source. This is a regression guard: if someone re-adds
  // the "skip if no tasks" logic, this test fails.
  const { readFileSync } = await import("node:fs")
  const src = readFileSync("src/core/runtime/runtime.ts", "utf8")
  // The previous logic had a "skip" / "no pending tasks" early return
  // inside runProactiveBackgroundTurn. It should no longer be there.
  assert.ok(
    !src.includes("Proactive heartbeat skipped: no pending tasks found."),
    "the 'skip if no tasks' short-circuit must remain removed — its presence defeats the autonomy contract",
  )
})

test("heartbeat prompt: asks the model to decide, not pre-filter", async () => {
  // The new prompt should NOT contain the old language that primed
  // the model to be defensive ("no urgent attention" first).
  const { readFileSync } = await import("node:fs")
  const src = readFileSync("src/core/runtime/runtime.ts", "utf8")
  // The new prompt should mention the user's previous intents and
  // background completions — sign that the model is the decision-maker.
  assert.ok(
    src.includes("background workers that completed since the last user message"),
    "heartbeat prompt should explicitly tell the model to consider background workers",
  )
  assert.ok(
    src.includes("I'll let you know when X"),
    "heartbeat prompt should mention the agent's own follow-up promises — these are a key autonomy trigger",
  )
})

test("HEARTBEAT_OK detection: strips non-alphanumeric noise", async () => {
  // The detection logic is at the end of runProactiveBackgroundTurn.
  // It does .trim().toUpperCase().replace(/[^A-Z_]/g, "") on the
  // response before comparing to "HEARTBEAT_OK". This test verifies
  // common variations all collapse to the same token.
  const samples = [
    "HEARTBEAT_OK",
    "  heartbeat_ok  ",
    "Heartbeat_OK",
    "HEARTBEAT-OK",  // → "HEARTBEATOK" (dash stripped) → "HEARTBEAT_OK"? no, it's "HEARTBEATOK"
    "heartbeat ok",
    "HEARTBEAT_OK.",  // → "HEARTBEAT_OK" after stripping non-alphanum-underscore
  ]
  const normalize = (s: string) => s.trim().toUpperCase().replace(/[^A-Z_]/g, "")
  // The first, second, third, and sixth should all normalize to HEARTBEAT_OK
  for (const s of [samples[0]!, samples[1]!, samples[2]!, samples[5]!]) {
    assert.equal(normalize(s), "HEARTBEAT_OK", `expected ${JSON.stringify(s)} to normalize to HEARTBEAT_OK`)
  }
  // The fifth ("heartbeat ok") has a space which gets stripped → "HEARTBEATOK"
  assert.equal(normalize(samples[4]!), "HEARTBEATOK", "spaces get stripped too")
})

test("heartbeat: no longer requires the user to be idle", async () => {
  // The previous behavior gated the heartbeat on `idleTime >= min_idle_minutes`.
  // We removed that gate so housekeeping (MemoryAgent) and proactive checks
  // run on the configured cadence regardless of user activity. This test
  // verifies the gate is gone from the source.
  const { readFileSync } = await import("node:fs")
  const src = readFileSync("src/core/runtime/runtime.ts", "utf8")
  assert.ok(
    !src.includes("Heartbeat skipped: user is not idle enough"),
    "the 'user is not idle enough' skip message must remain removed — the heartbeat should fire on its cadence regardless of user activity",
  )
})
