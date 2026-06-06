/**
 * Smoke tests for the orchestrator's decision logic.
 *
 * The orchestrator (src/core/runtime/orchestrator.ts, ~2300 lines) is the
 * second-largest file in the codebase and the most complex piece of
 * business logic: sub-agent spawning, renewal decisions, ralph-rule
 * verification, task tracking, and graceful shutdown coordination.
 *
 * This file targets the small, pure functions that are amenable to
 * unit testing without spinning up the full runtime. Larger integration
 * tests would need the daemon + SQLite + a real model backend.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { decideRenewal, MIN_ATTEMPTS_BEFORE_RENEWAL, MAX_ABSOLUTE_ATTEMPTS, MAX_RENEWAL_EXTENSIONS } from "./orchestrator.ts"

test("decideRenewal: returns cancel when absolute cap reached", () => {
  const v = decideRenewal(
    {
      recentSuccessCount: 100,
      recentWindowSize: 100,
      taskProgress: { totalTasks: 1, completedTasks: 1, pendingTasks: 0, inProgressTasks: 0, completionPct: 1.0, hasPlan: true },
      memoryPersistedRecently: true,
      palaceNodesPersisted: 5,
      hasPersistedAnywhere: true,
    },
    { attemptsUsed: MAX_ABSOLUTE_ATTEMPTS, extensionsUsed: 0 },
  )
  assert.equal(v.verdict, "cancel")
  assert.equal(v.capReached, true)
  assert.match(v.reasons[0]!, /absolute cap reached/)
})

test("decideRenewal: returns cancel when max extensions reached", () => {
  const v = decideRenewal(
    {
      recentSuccessCount: 5,
      recentWindowSize: 5,
      taskProgress: { totalTasks: 1, completedTasks: 1, pendingTasks: 0, inProgressTasks: 0, completionPct: 1.0, hasPlan: true },
      memoryPersistedRecently: true,
      palaceNodesPersisted: 5,
      hasPersistedAnywhere: true,
    },
    { attemptsUsed: 3, extensionsUsed: MAX_RENEWAL_EXTENSIONS },
  )
  assert.equal(v.verdict, "cancel")
  assert.equal(v.capReached, true)
  assert.match(v.reasons[0]!, /max extensions reached/)
})

test("decideRenewal: rejects renewal when attempts are below threshold", () => {
  // Sub-agent hit its initial budget but used fewer than MIN_ATTEMPTS_BEFORE_RENEWAL
  // attempts. Renewal would be premature — we don't have enough signal.
  const v = decideRenewal(
    {
      recentSuccessCount: 2,
      recentWindowSize: 2,
      taskProgress: { totalTasks: 2, completedTasks: 1, pendingTasks: 1, inProgressTasks: 0, completionPct: 0.5, hasPlan: true },
      memoryPersistedRecently: false,
      palaceNodesPersisted: 1,
      hasPersistedAnywhere: true,
    },
    { attemptsUsed: MIN_ATTEMPTS_BEFORE_RENEWAL - 1, extensionsUsed: 0 },
  )
  assert.equal(v.verdict, "cancel")
  assert.equal(v.capReached, false)
  assert.match(v.reasons[0]!, /too early/)
})

test("decideRenewal: renews when strong recent progress + high completion", () => {
  const v = decideRenewal(
    {
      recentSuccessCount: 4,
      recentWindowSize: 5,
      taskProgress: { totalTasks: 4, completedTasks: 3, pendingTasks: 1, inProgressTasks: 0, completionPct: 0.75, hasPlan: true },
      memoryPersistedRecently: true,
      palaceNodesPersisted: 3,
      hasPersistedAnywhere: true,
    },
    { attemptsUsed: 4, extensionsUsed: 0 },
  )
  // Verdict should be "extend" with non-trivial extraAttempts
  assert.equal(v.verdict, "extend")
  assert.ok(v.extraAttempts > 0)
})

test("decideRenewal: no plan is a negative signal but not auto-cancel", () => {
  // Sub-agent skipped the TodoWrite step. Strong recent progress otherwise.
  const v = decideRenewal(
    {
      recentSuccessCount: 3,
      recentWindowSize: 4,
      taskProgress: { totalTasks: 0, completedTasks: 0, pendingTasks: 0, inProgressTasks: 0, completionPct: 0, hasPlan: false },
      memoryPersistedRecently: false,
      palaceNodesPersisted: 0,
      hasPersistedAnywhere: false,
    },
    { attemptsUsed: 3, extensionsUsed: 0 },
  )
  // Should still consider renewal (the "no plan" is recorded in reasons but
  // doesn't auto-cancel — the sub-agent may have done real work anyway)
  assert.equal(v.verdict, "extend")
  assert.ok(v.reasons.some(r => r.includes("no TodoWrite plan")))
})
