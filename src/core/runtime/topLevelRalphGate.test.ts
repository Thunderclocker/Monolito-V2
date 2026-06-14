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
import { listSessionTasks, writeSessionTask, supersedeAllSessionTasks, deleteSessionTask } from "../session/store.ts"
import type { SessionTask } from "../session/store.ts"
import { evaluateTopLevelRalphGate, isScreenViewingRequest, isSecurityAuditRequest } from "./topLevelRalphGate.ts"

// All tests share a single rootDir because `getPaths` is anchored to
// MONOLITO_ROOT (a module-level constant) — every test would otherwise
// Tests use isolated temp MONOLITO_ROOT; active_tasks live in state JSON.
// between tests to keep them isolated.
const sharedRoot = mkdtempSync(join(tmpdir(), "monolito-topralph-test-"))
process.env.MONOLITO_ROOT = sharedRoot

function clearActiveTasks(sessionId: string) {
  supersedeAllSessionTasks(sharedRoot, sessionId)
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
    [],
    [],
    new Set(["task-2", "task-3"]),
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
  deleteSessionTask(sharedRoot, sessionId, "task-old", profileId)

  // Confirm it's filtered at the SQL level
  const visible = listSessionTasks(sharedRoot, sessionId, profileId)
  assert.equal(visible.length, 0, "listSessionTasks must filter superseded tasks")

  const result = evaluateTopLevelRalphGate(sharedRoot, sessionId, profileId, "task", 1, "ok")
  assert.equal(result.blocked, false)
  assert.equal(result.feedbackPrompt, null)
})

test("isScreenViewingRequest: matches various screen viewing questions and commands", () => {
  assert.equal(isScreenViewingRequest("qué ves en mi pantalla?"), true)
  assert.equal(isScreenViewingRequest("mirá mi pantalla"), true)
  assert.equal(isScreenViewingRequest("mira la pantalla y decime"), true)
  assert.equal(isScreenViewingRequest("what do you see on my screen?"), true)
  assert.equal(isScreenViewingRequest("look at my screen"), true)
  assert.equal(isScreenViewingRequest("describe what's on my screen"), true)
  assert.equal(isScreenViewingRequest("saca un screenshot"), true)
  assert.equal(isScreenViewingRequest("toma una captura"), true)
  assert.equal(isScreenViewingRequest("haz un pantallazo por fa"), true)
  assert.equal(isScreenViewingRequest("take a screenshot"), true)
  assert.equal(isScreenViewingRequest("hola cómo estás?"), false)
  assert.equal(isScreenViewingRequest("verificá la imagen"), false)
})

test("evaluateTopLevelRalphGate: blocks when screen-viewing request but CaptureScreenshot not executed", () => {
  const sessionId = "ralph-screenshot-missing"
  const profileId = "default"
  clearActiveTasks(sessionId)

  const result = evaluateTopLevelRalphGate(
    sharedRoot, sessionId, profileId,
    "qué ves en mi pantalla?",
    1,
    "no veo nada especial",
    [],
    []
  )

  assert.equal(result.blocked, true, "Gate must block when screen viewing request is not captured")
  assert.equal(result.shouldRetry, true)
  assert.ok(result.feedbackPrompt?.includes("CaptureScreenshot"))
})

test("evaluateTopLevelRalphGate: blocks when CaptureScreenshot is called but VisionAnalyze is not", () => {
  const sessionId = "ralph-vision-missing"
  const profileId = "default"
  clearActiveTasks(sessionId)

  const result = evaluateTopLevelRalphGate(
    sharedRoot, sessionId, profileId,
    "toma una captura de pantalla",
    1,
    "ya la tomé",
    [],
    [{ type: "tool", tool: "CaptureScreenshot", input: {} }]
  )

  assert.equal(result.blocked, true, "Gate must block when screenshot is not analyzed")
  assert.equal(result.shouldRetry, true)
  assert.ok(result.feedbackPrompt?.includes("VisionAnalyze"))
})

test("evaluateTopLevelRalphGate: passes when CaptureScreenshot and VisionAnalyze are both called", () => {
  const sessionId = "ralph-both-called"
  const profileId = "default"
  clearActiveTasks(sessionId)

  const result = evaluateTopLevelRalphGate(
    sharedRoot, sessionId, profileId,
    "qué ves?",
    1,
    "veo la terminal de visual studio code",
    [],
    [
      { type: "tool", tool: "CaptureScreenshot", input: {} },
      { type: "tool", tool: "VisionAnalyze", input: { path: "some/path.png" } }
    ]
  )

  assert.equal(result.blocked, false, "Gate must not block when both tools are called")
})

test("evaluateTopLevelRalphGate: passes when screenshot is pre-attached to user message and VisionAnalyze is called", () => {
  const sessionId = "ralph-pre-attached"
  const profileId = "default"
  clearActiveTasks(sessionId)

  const result = evaluateTopLevelRalphGate(
    sharedRoot, sessionId, profileId,
    "qué ves en mi pantalla?\n\n<attachment kind=\"photo\" local_path=\"/some/screenshot.png\" />",
    1,
    "veo la terminal",
    [],
    [
      { type: "tool", tool: "VisionAnalyze", input: { path: "/some/screenshot.png" } }
    ]
  )

  assert.equal(result.blocked, false, "Gate must pass without CaptureScreenshot if already attached and analyzed")
})

test("evaluateTopLevelRalphGate: passes when assistantReply contains TASK_FAILED", () => {
  const sessionId = "ralph-failed-escape"
  const profileId = "default"
  clearActiveTasks(sessionId)
  writeSessionTask(sharedRoot, sessionId, "task-1", {
    id: "task-1",
    sessionId,
    content: "Task A",
    activeForm: "Doing A",
    status: "pending",
    createdAt: "2026-06-05T13:13:05.372Z",
    updatedAt: "2026-06-05T13:13:05.372Z",
  } as SessionTask, profileId)

  const result = evaluateTopLevelRalphGate(
    sharedRoot, sessionId, profileId,
    "do task",
    1,
    "Lo intenté pero: TASK_FAILED: No se pudo conectar a internet",
  )

  assert.equal(result.blocked, false, "Gate must not block if TASK_FAILED is present in the assistant reply")
})

test("evaluateTopLevelRalphGate: ignores tasks with category 'life'", () => {
  const sessionId = "ralph-life-task"
  const profileId = "default"
  clearActiveTasks(sessionId)
  writeSessionTask(sharedRoot, sessionId, "task-1", {
    id: "task-1",
    sessionId,
    content: "Repintar marco metalico",
    activeForm: "Repintando marco",
    status: "pending",
    category: "life",
    createdAt: "2026-06-05T13:13:05.372Z",
    updatedAt: "2026-06-05T13:13:05.372Z",
  } as SessionTask, profileId)

  const result = evaluateTopLevelRalphGate(
    sharedRoot, sessionId, profileId,
    "repaint frame",
    1,
    "No puedo hacerlo yo mismo en el mundo fisico",
  )

  assert.equal(result.blocked, false, "Gate must not block on life tasks")
})

test("evaluateTopLevelRalphGate: ignores mid-turn cognitive tasks when preExistingTaskIds is set", () => {
  const sessionId = "ralph-midturn-tasks"
  const profileId = "default"
  clearActiveTasks(sessionId)

  // Task created mid-turn by the agent (not in the turn-start snapshot)
  writeSessionTask(sharedRoot, sessionId, "task-midturn", {
    id: "task-midturn",
    sessionId,
    content: "Clarify title scope with user",
    activeForm: "Clarifying title scope",
    status: "pending",
    category: "cognitive",
    createdAt: "2026-06-14T19:41:00.000Z",
    updatedAt: "2026-06-14T19:41:00.000Z",
  } as SessionTask, profileId)

  const result = evaluateTopLevelRalphGate(
    sharedRoot, sessionId, profileId,
    "para los dos o para cual?",
    1,
    "Para una sola tarea — la ventana. Te había dado dos opciones de título.",
    [],
    [],
    new Set(), // no pre-existing tasks at turn start
  )

  assert.equal(result.blocked, false, "Gate must not block on tasks created mid-turn")
  assert.equal(result.feedbackPrompt, null)
})

test("isSecurityAuditRequest detects PC security questions", () => {
  assert.equal(isSecurityAuditRequest("che que tan segura es mi pc"), true)
  assert.equal(isSecurityAuditRequest("auditá mi pc"), true)
  assert.equal(isSecurityAuditRequest("como estas"), false)
})

test("evaluateTopLevelRalphGate blocks security audit without tools", () => {
  const result = evaluateTopLevelRalphGate(
    sharedRoot,
    "orchestrator",
    "default",
    "che que tan segura es mi pc",
    1,
    "¿Querés que la audite?",
    [],
    [],
    new Set(),
  )
  assert.equal(result.blocked, true)
  assert.match(result.feedbackPrompt ?? "", /Bash|system_status/i)
})

