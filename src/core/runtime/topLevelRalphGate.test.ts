// Test for the top-level Ralph gate (Stop-hook analog for the orchestrator
// session). The bug it reproduces: when a top-level session registers a
// TodoWrite with pending or in_progress items, the runtime delivers the
// assistant reply to the user without checking the task list. The fix is
// a runtime-level gate that blocks delivery, feeds the unfinished-tasks
// prompt back as a user message, and re-runs the agent loop.
//
// This file pins the contract for `evaluateTopLevelRalphGate`. Mirrors
// the same approach upstream reference uses with the Ralph Wiggum Stop hook.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listSessionTasks, writeSessionTask, getDb } from "../session/store.ts"
import type { SessionTask } from "../session/store.ts"
import { evaluateTopLevelRalphGate } from "./orchestrator.ts"

// All tests share a single rootDir because `getPaths` is anchored to
// MONOLITO_ROOT (a module-level constant) — every test would otherwise
// write to the same SQLite file. We clean the active_tasks table
// between tests to keep them isolated.
const sharedRoot = mkdtempSync(join(tmpdir(), "monolito-topralph-test-"))
process.env.MONOLITO_ROOT = sharedRoot

function clearActiveTasks(sessionId: string) {
  const db = getDb(sharedRoot)
  db.prepare(
    `UPDATE palace_nodes SET superseded_at = ? WHERE wing = 'active_tasks' AND room = ? AND superseded_at IS NULL`,
  ).run(new Date().toISOString(), sessionId)
}

test.after(() => {
  rmSync(sharedRoot, { recursive: true, force: true })
})

test("evaluateTopLevelRalphGate: blocks when there are pending tasks", () => {
  const sessionId = "orchestrator-bug-repro"
  const profileId = "default"
  clearActiveTasks(sessionId)

  // Simulate the exact bug from the production DB: agent registered a
  // 3-item TodoWrite, completed one, marked one in_progress, left one
  // pending — then changed topic and tried to close the turn.
  writeSessionTask(sharedRoot, sessionId, "task-1", {
    id: "task-1",
    sessionId,
    content: "Save critical identity/user rules to BOOT_USER and BOOT_SOUL",
    activeForm: "Saving critical identity/user rules to BOOT_USER and BOOT_SOUL",
    status: "completed",
    createdAt: "2026-06-05T13:13:05.372Z",
    updatedAt: "2026-06-05T13:13:05.372Z",
  } as SessionTask, profileId)
  writeSessionTask(sharedRoot, sessionId, "task-2", {
    id: "task-2",
    sessionId,
    content: "Save preferences and tasks to Memory Palace rooms",
    activeForm: "Saving preferences and tasks to Memory Palace rooms",
    status: "pending",
    createdAt: "2026-06-05T13:13:05.372Z",
    updatedAt: "2026-06-05T13:13:05.372Z",
  } as SessionTask, profileId)
  writeSessionTask(sharedRoot, sessionId, "task-3", {
    id: "task-3",
    sessionId,
    content: "Save VPS access facts and DB locations to Memory Palace",
    activeForm: "Saving VPS access facts and DB locations to Memory Palace",
    status: "in_progress",
    createdAt: "2026-06-05T13:13:05.372Z",
    updatedAt: "2026-06-05T13:13:05.372Z",
  } as SessionTask, profileId)

  const result = evaluateTopLevelRalphGate(
    sharedRoot, sessionId, profileId,
    "save identity, preferences, and VPS facts",
    1,
    "ahí va, pará, me mandé una macana",
  )

  assert.equal(result.blocked, true, "Gate must block when pending/in_progress tasks exist")
  assert.equal(result.shouldRetry, true, "Gate must request a retry (re-feed the prompt)")
  assert.ok(typeof result.feedbackPrompt === "string", "Gate must return a feedback prompt")
  assert.ok(result.feedbackPrompt.length > 0, "Feedback prompt must be non-empty")
  assert.ok(
    result.feedbackPrompt.includes("AUDIT FEEDBACK"),
    "Feedback prompt must be wrapped with the audit demarcation",
  )
  assert.ok(
    result.feedbackPrompt.includes("Tareas en tu lista que quedaron abiertas"),
    "Feedback prompt must reference the unfinished tasks list",
  )
  assert.ok(
    result.feedbackPrompt.includes("Save preferences and tasks to Memory Palace rooms"),
    "Feedback prompt must list the pending task by content",
  )
  assert.ok(
    result.feedbackPrompt.includes("Save VPS access facts and DB locations to Memory Palace"),
    "Feedback prompt must list the in_progress task by content",
  )
  assert.equal(result.unfinished.length, 2, "Gate must report both unfinished items")
})

test("evaluateTopLevelRalphGate: passes when all tasks are completed", () => {
  const sessionId = "orchestrator-all-done"
  const profileId = "default"
  clearActiveTasks(sessionId)
  writeSessionTask(sharedRoot, sessionId, "task-1", {
    id: "task-1",
    sessionId,
    content: "Task A",
    activeForm: "Doing A",
    status: "completed",
    createdAt: "2026-06-05T13:13:05.372Z",
    updatedAt: "2026-06-05T13:13:05.372Z",
  } as SessionTask, profileId)
  writeSessionTask(sharedRoot, sessionId, "task-2", {
    id: "task-2",
    sessionId,
    content: "Task B",
    activeForm: "Doing B",
    status: "completed",
    createdAt: "2026-06-05T13:13:05.372Z",
    updatedAt: "2026-06-05T13:13:05.372Z",
  } as SessionTask, profileId)

  const result = evaluateTopLevelRalphGate(sharedRoot, sessionId, profileId, "do A and B", 1, "all done")

  assert.equal(result.blocked, false, "Gate must not block when all tasks are completed")
  assert.equal(result.shouldRetry, false, "Gate must not request a retry")
  assert.equal(result.feedbackPrompt, null, "No feedback prompt when clean")
  assert.equal(result.unfinished.length, 0, "No unfinished items reported")
})

test("evaluateTopLevelRalphGate: passes when there are no tasks at all", () => {
  const sessionId = "orchestrator-empty"
  clearActiveTasks(sessionId)
  const result = evaluateTopLevelRalphGate(sharedRoot, sessionId, "default", "hi", 1, "hi")
  assert.equal(result.blocked, false)
  assert.equal(result.shouldRetry, false)
  assert.equal(result.feedbackPrompt, null)
  assert.equal(result.unfinished.length, 0)
})

test("evaluateTopLevelRalphGate: ignores superseded tasks", () => {
  const sessionId = "orchestrator-superseded"
  const profileId = "default"
  clearActiveTasks(sessionId)
  writeSessionTask(sharedRoot, sessionId, "task-old", {
    id: "task-old",
    sessionId,
    content: "Old superseded task",
    activeForm: "Doing old",
    status: "in_progress",
    createdAt: "2026-06-05T12:00:00.000Z",
    updatedAt: "2026-06-05T12:00:00.000Z",
  } as SessionTask, profileId)
  // Manually mark superseded
  const db = getDb(sharedRoot)
  db.prepare(
    `UPDATE palace_nodes SET superseded_at = ? WHERE wing = 'active_tasks' AND room = ? AND node_key = ? AND superseded_at IS NULL`,
  ).run("2026-06-05T13:00:00.000Z", sessionId, "task-old")

  // Confirm it's filtered at the SQL level
  const visible = listSessionTasks(sharedRoot, sessionId, profileId)
  assert.equal(visible.length, 0, "listSessionTasks must filter superseded tasks")

  const result = evaluateTopLevelRalphGate(sharedRoot, sessionId, profileId, "task", 1, "ok")
  assert.equal(result.blocked, false)
  assert.equal(result.feedbackPrompt, null)
})
