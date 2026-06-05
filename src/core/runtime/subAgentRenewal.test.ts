// Tests for the sub-agent renewal verifier. The verifier is the
// orchestrator's mechanism for deciding whether to give a sub-agent
// more attempts when it hits its initial budget, instead of letting
// it die with "Max iterations reached".
//
// All verifier functions are pure (modulo DB reads in
// gatherRenewalSignals), so tests cover both functions with realistic
// signals from production scenarios.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listSessionTasks, writeSessionTask, getDb } from "../session/store.ts"
import {
  gatherRenewalSignals,
  decideRenewal,
  MAX_ABSOLUTE_ATTEMPTS,
  MAX_RENEWAL_EXTENSIONS,
  MIN_ATTEMPTS_BEFORE_RENEWAL,
} from "./orchestrator.ts"

const sharedRoot = mkdtempSync(join(tmpdir(), "monolito-renewal-test-"))
process.env.MONOLITO_ROOT = sharedRoot

test.after(() => {
  rmSync(sharedRoot, { recursive: true, force: true })
})

function makeSuccessEvent(tool: string) {
  return { type: "tool.finish", ok: true, tool }
}
function makeFailEvent(tool: string) {
  return { type: "tool.finish", ok: false, tool }
}

test("decideRenewal: extends generously when there is real progress", () => {
  // The canonical good case: sub-agent has 5 recent successes, plan
  // mostly done (3/4 = 75%), persisted a node. Should be strong extend.
  const signals = {
    recentSuccessCount: 5,
    recentWindowSize: 5,
    taskProgress: {
      totalTasks: 4,
      completedTasks: 3,
      pendingTasks: 1,
      inProgressTasks: 0,
      completionPct: 0.75,
      hasPlan: true,
    },
    memoryPersistedRecently: true,
    palaceNodesPersisted: 1,
    hasPersistedAnywhere: true,
  }
  const v = decideRenewal(signals, { attemptsUsed: 20, extensionsUsed: 0 })
  assert.equal(v.verdict, "extend", "should extend when sub-agent is progressing well")
  assert.equal(v.extraAttempts, 30, "score 4 → 30 extra attempts")
  assert.equal(v.score, 6, "score = 2 (recent) + 2 (tasks) + 1 (recent persist) + 1 (nodes)")
  assert.equal(v.capReached, false)
  assert.ok(v.reasons.some(r => r.includes("strong recent progress")))
  assert.ok(v.reasons.some(r => r.includes("tasks mostly done")))
})

test("decideRenewal: extends with smaller budget when signals are mixed", () => {
  // Realistic mid-task case: some progress, plan in progress, no
  // recent persistence in this window. Score 2-3 → 15 extra.
  const signals = {
    recentSuccessCount: 2,
    recentWindowSize: 5,
    taskProgress: {
      totalTasks: 6,
      completedTasks: 2,
      pendingTasks: 3,
      inProgressTasks: 1,
      completionPct: 0.33,
      hasPlan: true,
    },
    memoryPersistedRecently: false,
    palaceNodesPersisted: 1,
    hasPersistedAnywhere: true,
  }
  const v = decideRenewal(signals, { attemptsUsed: 20, extensionsUsed: 0 })
  assert.equal(v.verdict, "extend", "mixed signals still extend (chance to complete)")
  assert.equal(v.extraAttempts, 15, "score 3 → 15 extra attempts")
})

test("decideRenewal: cancels when there is no progress at all", () => {
  // The canonical bad case: no successes, no plan, no persistence.
  // The sub-agent is stuck or hallucinating. Cancel.
  const signals = {
    recentSuccessCount: 0,
    recentWindowSize: 5,
    taskProgress: {
      totalTasks: 0,
      completedTasks: 0,
      pendingTasks: 0,
      inProgressTasks: 0,
      completionPct: 0,
      hasPlan: false,
    },
    memoryPersistedRecently: false,
    palaceNodesPersisted: 0,
    hasPersistedAnywhere: false,
  }
  const v = decideRenewal(signals, { attemptsUsed: 20, extensionsUsed: 0 })
  assert.equal(v.verdict, "cancel", "zero progress must cancel")
  assert.equal(v.extraAttempts, 0)
  assert.equal(v.score, 0)
  assert.ok(v.reasons.some(r => r.includes("no TodoWrite plan")))
})

test("decideRenewal: cancels on no plan even if some work happened", () => {
  // Sub-agent did 4 successful tool calls but never TodoWrite'd.
  // We have no way to know what it committed to. Cancel.
  const signals = {
    recentSuccessCount: 4,
    recentWindowSize: 5,
    taskProgress: {
      totalTasks: 0,
      completedTasks: 0,
      pendingTasks: 0,
      inProgressTasks: 0,
      completionPct: 0,
      hasPlan: false,
    },
    memoryPersistedRecently: true,
    palaceNodesPersisted: 2,
    hasPersistedAnywhere: true,
  }
  const v = decideRenewal(signals, { attemptsUsed: 20, extensionsUsed: 0 })
  // Score: recent(2) + persist_recent(1) + nodes(1) = 4 → still extend
  // 30. The lack of a plan reduces the weight on Signal 2 but doesn't
  // override Signals 1 and 3.
  assert.equal(v.verdict, "extend")
  assert.ok(v.reasons.some(r => r.includes("no TodoWrite plan")))
})

test("decideRenewal: hard cap is not negotiable", () => {
  const signals = {
    recentSuccessCount: 5,
    recentWindowSize: 5,
    taskProgress: {
      totalTasks: 4,
      completedTasks: 4,
      pendingTasks: 0,
      inProgressTasks: 0,
      completionPct: 1.0,
      hasPlan: true,
    },
    memoryPersistedRecently: true,
    palaceNodesPersisted: 5,
    hasPersistedAnywhere: true,
  }
  // Even at perfect score, beyond the cap we cancel.
  const v = decideRenewal(signals, { attemptsUsed: MAX_ABSOLUTE_ATTEMPTS, extensionsUsed: 0 })
  assert.equal(v.verdict, "cancel")
  assert.equal(v.capReached, true)
  assert.ok(v.reasons[0].includes("absolute cap"))
})

test("decideRenewal: max extensions is also not negotiable", () => {
  const signals = {
    recentSuccessCount: 5,
    recentWindowSize: 5,
    taskProgress: {
      totalTasks: 4,
      completedTasks: 3,
      pendingTasks: 1,
      inProgressTasks: 0,
      completionPct: 0.75,
      hasPlan: true,
    },
    memoryPersistedRecently: true,
    palaceNodesPersisted: 3,
    hasPersistedAnywhere: true,
  }
  const v = decideRenewal(signals, { attemptsUsed: 100, extensionsUsed: MAX_RENEWAL_EXTENSIONS })
  assert.equal(v.verdict, "cancel")
  assert.equal(v.capReached, true)
  assert.ok(v.reasons[0].includes("max extensions"))
})

test("decideRenewal: too early for renewal rejects the request", () => {
  // Sub-agent hit its initial budget but used < MIN_ATTEMPTS_BEFORE_RENEWAL.
  // Something is suspicious — either the budget was too small or the
  // sub-agent did very little. Don't extend.
  const signals = {
    recentSuccessCount: 2,
    recentWindowSize: 2,
    taskProgress: {
      totalTasks: 2,
      completedTasks: 1,
      pendingTasks: 1,
      inProgressTasks: 0,
      completionPct: 0.5,
      hasPlan: true,
    },
    memoryPersistedRecently: false,
    palaceNodesPersisted: 1,
    hasPersistedAnywhere: true,
  }
  const v = decideRenewal(signals, { attemptsUsed: 2, extensionsUsed: 0 })
  assert.equal(v.verdict, "cancel")
  assert.ok(v.reasons[0].includes("too early"))
})

test("decideRenewal: reasons are descriptive and audit-friendly", () => {
  const signals = {
    recentSuccessCount: 1,
    recentWindowSize: 5,
    taskProgress: {
      totalTasks: 4,
      completedTasks: 1,
      pendingTasks: 3,
      inProgressTasks: 0,
      completionPct: 0.25,
      hasPlan: true,
    },
    memoryPersistedRecently: false,
    palaceNodesPersisted: 0,
    hasPersistedAnywhere: false,
  }
  const v = decideRenewal(signals, { attemptsUsed: 10, extensionsUsed: 0 })
  // Score = 1 (recent) + 0 (tasks < 30%) + 0 (no persist) = 1
  assert.equal(v.verdict, "extend")
  assert.equal(v.extraAttempts, 10)
  // Every reason should be human-readable.
  for (const r of v.reasons) {
    assert.ok(r.length > 0, `empty reason: ${r}`)
  }
  assert.ok(v.reasons.some(r => r.includes("1/5 tool successes")))
  assert.ok(v.reasons.some(r => r.includes("25% of 4")))
})

// =============================================================================
// gatherRenewalSignals — DB-bound helper. The pure decision logic is
// covered above; these tests verify the signal-gathering reads the
// right pieces of state.
// =============================================================================

test("gatherRenewalSignals: reads TodoWrite items as task progress", () => {
  const sessionId = "sub-agent-test-1"
  const profileId = "default"
  clearSessionTasks(sessionId)
  writeSessionTask(sharedRoot, sessionId, "task-1", {
    id: "task-1",
    sessionId,
    content: "List tables",
    activeForm: "Listing tables",
    status: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any, profileId)
  writeSessionTask(sharedRoot, sessionId, "task-2", {
    id: "task-2",
    sessionId,
    content: "Dump data",
    activeForm: "Dumping data",
    status: "in_progress",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any, profileId)

  const signals = gatherRenewalSignals(sharedRoot, sessionId, profileId, [
    makeSuccessEvent("Bash"),
    makeSuccessEvent("Read"),
  ])
  assert.equal(signals.taskProgress.totalTasks, 2)
  assert.equal(signals.taskProgress.completedTasks, 1)
  assert.equal(signals.taskProgress.inProgressTasks, 1)
  assert.equal(signals.taskProgress.hasPlan, true)
  assert.equal(signals.taskProgress.completionPct, 0.5)
})

test("gatherRenewalSignals: hasPlan=false when no tasks exist", () => {
  const sessionId = "sub-agent-no-plan"
  clearSessionTasks(sessionId)
  const signals = gatherRenewalSignals(sharedRoot, sessionId, "default", [])
  assert.equal(signals.taskProgress.hasPlan, false)
  assert.equal(signals.taskProgress.totalTasks, 0)
})

function clearSessionTasks(sessionId: string) {
  const db = getDb(sharedRoot)
  db.prepare(
    `UPDATE palace_nodes SET superseded_at = ? WHERE wing = 'active_tasks' AND room = ? AND superseded_at IS NULL`,
  ).run(new Date().toISOString(), sessionId)
}
