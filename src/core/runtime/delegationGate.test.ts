// Test for the auto-delegate gate. Pin the contract for
// checkDelegateThreshold: a pure function that decides whether the
// runtime should auto-delegate the current turn to a sub-agent
// because the model is doing multi-step Bash work in the main
// session without first planning with TodoWrite/AgentSpawn.
//
// Production repro that motivated this fix (from real worklog on
// 2026-06-05 17:42 UTC): the orchestrator session executed 5 Bash
// tools in a single turn without a TodoWrite or AgentSpawn, hit the
// 95s turn timeout, and the user saw "Mi último turn terminó sin
// respuesta" three times in a row.

import test from "node:test"
import assert from "node:assert/strict"
import { checkDelegateThreshold, PLANNING_TOOLS, LIGHT_TOOLS } from "./orchestrator.ts"

test("checkDelegateThreshold: 1 Bash call is allowed", () => {
  const r = checkDelegateThreshold(["Bash"], "Bash")
  assert.equal(r.shouldDelegate, false, "single Bash call must not trigger delegation")
  assert.equal(r.bashCount, 1)
  assert.equal(r.planningToolUsed, false)
})

test("checkDelegateThreshold: 2nd Bash without plan triggers delegation", () => {
  const r = checkDelegateThreshold(["Bash", "Bash"], "Bash")
  assert.equal(r.shouldDelegate, true, "2nd Bash without TodoWrite/AgentSpawn must trigger delegation")
  assert.equal(r.bashCount, 2)
  assert.equal(r.planningToolUsed, false)
  assert.ok(r.reason.toLowerCase().includes("bash"), "reason must mention bash")
})

test("checkDelegateThreshold: TodoWrite before Bash silences the gate", () => {
  // Realistic flow: model plans first, then executes Bash tools.
  const tools = ["TodoWrite", "Bash", "Bash", "Bash"]
  const r = checkDelegateThreshold(tools, "Bash")
  assert.equal(r.shouldDelegate, false, "TodoWrite at the start silences the gate")
  assert.equal(r.planningToolUsed, true)
})

test("checkDelegateThreshold: AgentSpawn also silences the gate", () => {
  const tools = ["AgentSpawn", "Bash", "Bash"]
  const r = checkDelegateThreshold(tools, "Bash")
  assert.equal(r.shouldDelegate, false)
  assert.equal(r.planningToolUsed, true)
})

test("checkDelegateThreshold: delegate_background_task silences the gate", () => {
  const tools = ["delegate_background_task", "Bash", "Bash"]
  const r = checkDelegateThreshold(tools, "Bash")
  assert.equal(r.shouldDelegate, false)
  assert.equal(r.planningToolUsed, true)
})

test("checkDelegateThreshold: light tools between Bashes do not silence the gate", () => {
  // Read + 2 Bashes without plan: still multi-step shell work.
  const tools = ["Read", "Bash", "Bash"]
  const r = checkDelegateThreshold(tools, "Bash")
  assert.equal(r.shouldDelegate, true, "Read is not a planning tool; gate still fires")
  assert.equal(r.planningToolUsed, false)
})

test("checkDelegateThreshold: non-Bash tool never triggers delegation", () => {
  const r = checkDelegateThreshold(["Read", "Read"], "Read")
  assert.equal(r.shouldDelegate, false, "Read is not Bash; gate is silent")
})

test("checkDelegateThreshold: 5 Bash calls in a row is the canonical bad case", () => {
  // Real-world bad flow: model reads nothing, plans nothing, just runs
  // 5 small Python scripts via Bash one at a time and burns the 95s
  // turn timeout.
  const tools = ["Bash", "Bash", "Bash", "Bash", "Bash"]
  const r = checkDelegateThreshold(tools, "Bash")
  assert.equal(r.shouldDelegate, true)
  assert.equal(r.bashCount, 5)
})

test("checkDelegateThreshold: custom bashThreshold is respected", () => {
  // Default threshold is 2; with threshold 4, three Bashes pass.
  const r = checkDelegateThreshold(["Bash", "Bash", "Bash"], "Bash", { bashThreshold: 4 })
  assert.equal(r.shouldDelegate, false, "threshold 4 means 3 Bashes are still OK")
  const r2 = checkDelegateThreshold(["Bash", "Bash", "Bash", "Bash"], "Bash", { bashThreshold: 4 })
  assert.equal(r2.shouldDelegate, true, "threshold 4 means 4 Bashes trigger")
})

test("checkDelegateThreshold: PLANNING_TOOLS includes the canonical set", () => {
  // Sanity: make sure the constants stay useful.
  assert.ok(PLANNING_TOOLS.has("TodoWrite"))
  assert.ok(PLANNING_TOOLS.has("AgentSpawn"))
  assert.ok(PLANNING_TOOLS.has("delegate_background_task"))
  // Sanity: LIGHT_TOOLS does not include Bash.
  assert.ok(!LIGHT_TOOLS.has("Bash"))
  assert.ok(!PLANNING_TOOLS.has("Bash"))
})

test("checkDelegateThreshold: empty tool list returns no-delegate", () => {
  const r = checkDelegateThreshold([], "Bash")
  assert.equal(r.shouldDelegate, false)
  assert.equal(r.bashCount, 0)
})
