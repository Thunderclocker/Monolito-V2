import test from "node:test"
import assert from "node:assert/strict"

const { isRuntimeControlCommand, RUNTIME_CONTROL_COMMANDS } = await import("./runtimeControlCommands.ts")

test("isRuntimeControlCommand: control commands match", () => {
  assert.equal(isRuntimeControlCommand("/update"), true)
  assert.equal(isRuntimeControlCommand("/stop"), true)
  assert.equal(isRuntimeControlCommand("/new"), true)
  assert.equal(isRuntimeControlCommand("/reset"), true)
  assert.equal(isRuntimeControlCommand("/quit"), true)
  assert.equal(isRuntimeControlCommand("/exit"), true)
})

test("isRuntimeControlCommand: control commands match with trailing args", () => {
  assert.equal(isRuntimeControlCommand("/update "), true)
  assert.equal(isRuntimeControlCommand("/update origin main"), true)
  assert.equal(isRuntimeControlCommand("/stop "), true)
})

test("isRuntimeControlCommand: control commands are case-insensitive", () => {
  assert.equal(isRuntimeControlCommand("/UPDATE"), true)
  assert.equal(isRuntimeControlCommand("/Update"), true)
  assert.equal(isRuntimeControlCommand("/STOP"), true)
})

test("isRuntimeControlCommand: read-only commands do NOT match", () => {
  // These can safely wait behind an in-flight turn.
  assert.equal(isRuntimeControlCommand("/help"), false)
  assert.equal(isRuntimeControlCommand("/status"), false)
  assert.equal(isRuntimeControlCommand("/sessions"), false)
  assert.equal(isRuntimeControlCommand("/doctor"), false)
  assert.equal(isRuntimeControlCommand("/config"), false)
  assert.equal(isRuntimeControlCommand("/model"), false)
  assert.equal(isRuntimeControlCommand("/channels"), false)
  assert.equal(isRuntimeControlCommand("/dashboard"), false)
  assert.equal(isRuntimeControlCommand("/clear"), false)
  assert.equal(isRuntimeControlCommand("/websearch"), false)
})

test("isRuntimeControlCommand: free-form prompts do NOT match", () => {
  assert.equal(isRuntimeControlCommand("hola"), false)
  assert.equal(isRuntimeControlCommand(""), false)
  // Leading whitespace is trimmed before the lookup, so "  /update"
  // still matches — the same path the interactive composer takes.
  assert.equal(isRuntimeControlCommand("  /update"), true)
  // The 06-jun incident was: user types /update, hits Enter, daemon
  // is busy → 'Queued for later: /update'. After this fix the line
  // is also passed through isRuntimeControlCommand which returns
  // true, so the in-flight turn gets aborted.
  assert.equal(isRuntimeControlCommand("/update"), true, "this is the regression case for the 06-jun-2026 incident")
})

test("RUNTIME_CONTROL_COMMANDS is exported as a frozen-ish readonly set", () => {
  // The set itself is a runtime Set (mutable at the type level), but
  // by convention consumers should treat it as read-only. Just assert
  // it contains the expected entries so accidental removals are
  // caught by tests.
  assert.ok(RUNTIME_CONTROL_COMMANDS.has("/update"))
  assert.ok(RUNTIME_CONTROL_COMMANDS.has("/stop"))
  assert.ok(RUNTIME_CONTROL_COMMANDS.has("/new"))
  assert.ok(RUNTIME_CONTROL_COMMANDS.has("/reset"))
  assert.ok(RUNTIME_CONTROL_COMMANDS.has("/quit"))
  assert.ok(RUNTIME_CONTROL_COMMANDS.has("/exit"))
  // Read-only commands must NOT be in the set.
  assert.equal(RUNTIME_CONTROL_COMMANDS.has("/help"), false)
  assert.equal(RUNTIME_CONTROL_COMMANDS.has("/status"), false)
})
