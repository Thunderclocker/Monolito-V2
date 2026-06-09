// Tests for the per-tool rolling failure tracker.
//
// Bug #4 (09-jun-2026): 83 [tdd-react] Execution failure log lines in 7 days,
// each fired independently with no rate limiting or aggregation. A user
// with a broken tool (e.g. wrong API key for xAI Grok) would see 80+
// noisy logs and miss the signal. The new tracker emits ONE aggregated
// warn after the same tool fails 3+ times in 10 minutes.

import { test } from "node:test"
import assert from "node:assert/strict"
import { ToolFailureTracker } from "./modelAdapter.ts"

test("ToolFailureTracker: single failure returns null (no alert)", () => {
  const t = new ToolFailureTracker({ now: () => 1000 })
  assert.equal(t.recordFailure("Bash", "exit 1"), null)
})

test("ToolFailureTracker: two failures return null (under threshold)", () => {
  const t = new ToolFailureTracker({ now: () => 1000 })
  assert.equal(t.recordFailure("Bash", "exit 1"), null)
  assert.equal(t.recordFailure("Bash", "exit 1"), null)
})

test("ToolFailureTracker: three failures in 5 minutes returns alert (threshold met)", () => {
  let nowMs = 0
  const t = new ToolFailureTracker({
    now: () => nowMs,
  })
  t.recordFailure("Bash", "exit 1")
  nowMs += 60_000 // +1 min
  t.recordFailure("Bash", "exit 1")
  nowMs += 60_000 // +1 min
  const alert = t.recordFailure("Bash", "exit 1")
  assert.ok(alert !== null, "third failure should trigger alert")
  assert.equal(alert?.toolName, "Bash")
  assert.equal(alert?.count, 3)
  assert.equal(alert?.windowMin, 2)
  assert.equal(alert?.snippets.length, 3)
})

test("ToolFailureTracker: 4th, 5th, ... failures also return alert (sustained)", () => {
  let nowMs = 0
  const t = new ToolFailureTracker({ now: () => nowMs })
  t.recordFailure("Bash", "a")
  nowMs += 60_000
  t.recordFailure("Bash", "b")
  nowMs += 60_000
  const a3 = t.recordFailure("Bash", "c")
  assert.ok(a3)
  nowMs += 60_000
  const a4 = t.recordFailure("Bash", "d")
  assert.ok(a4)
  assert.equal(a4?.count, 4)
})

test("ToolFailureTracker: tool failures are tracked per-tool independently", () => {
  let nowMs = 0
  const t = new ToolFailureTracker({ now: () => nowMs })
  // Bash fails 3 times → alert
  t.recordFailure("Bash", "x")
  nowMs += 10_000
  t.recordFailure("Bash", "x")
  nowMs += 10_000
  const bashAlert = t.recordFailure("Bash", "x")
  assert.ok(bashAlert, "Bash should alert")
  // Edit has only 1 failure → no alert
  const editAlert = t.recordFailure("Edit", "y")
  assert.equal(editAlert, null, "Edit should not alert on 1 failure")
  // Now Edit has 3 too
  nowMs += 10_000
  t.recordFailure("Edit", "y")
  nowMs += 10_000
  const editAlert2 = t.recordFailure("Edit", "y")
  assert.ok(editAlert2, "Edit should alert on 3rd failure")
  assert.equal(editAlert2?.toolName, "Edit")
  // Bash's count is still 3 (unchanged by Edit's failures)
  const snap = t.snapshot()
  const bashSnap = snap.find(s => s.toolName === "Bash")
  const editSnap = snap.find(s => s.toolName === "Edit")
  assert.equal(bashSnap?.count, 3)
  assert.equal(editSnap?.count, 3)
})

test("ToolFailureTracker: entries older than window are pruned (lazy GC)", () => {
  let nowMs = 0
  const t = new ToolFailureTracker({
    windowMs: 10 * 60 * 1000,
    now: () => nowMs,
  })
  t.recordFailure("Bash", "x")
  // Jump forward 11 minutes — entry is now stale
  nowMs += 11 * 60_000
  // Recording a new failure should: GC the old entry, then create a new
  // entry for Bash with count=1 (not count=2). So no alert yet.
  const alert = t.recordFailure("Bash", "y")
  assert.equal(alert, null, "stale entry should be pruned, count resets")
  const snap = t.snapshot()
  assert.equal(snap.length, 1)
  assert.equal(snap[0].count, 1)
})

test("ToolFailureTracker: snippets are capped at maxSnippetsPerTool", () => {
  let nowMs = 0
  const t = new ToolFailureTracker({
    now: () => nowMs,
    maxSnippetsPerTool: 3,
  })
  for (let i = 0; i < 10; i++) {
    t.recordFailure("Bash", `failure-${i}`)
    nowMs += 1000
  }
  // 10 failures recorded but only the last 3 snippets retained
  const alert = t.recordFailure("Bash", "final")
  assert.ok(alert)
  assert.equal(alert?.snippets.length, 3)
  // The last 3 entries: failure-8, failure-9, "final"
  assert.equal(alert?.snippets[0], "failure-8")
  assert.equal(alert?.snippets[1], "failure-9")
  assert.equal(alert?.snippets[2], "final")
})

test("ToolFailureTracker: snapshot is read-only and decoupled", () => {
  const t = new ToolFailureTracker({ now: () => 1000 })
  t.recordFailure("Bash", "x")
  const snap1 = t.snapshot()
  t.recordFailure("Bash", "y")
  const snap2 = t.snapshot()
  // snap1 should not reflect the second failure
  assert.equal(snap1[0].count, 1)
  assert.equal(snap2[0].count, 2)
})
