import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listSessionTasks, writeConfigWing } from "../session/store.ts"
import {
  advanceProactiveTasksOnToolSuccess,
  isLiveWebDataRequest,
  seedLiveWebProactiveTasksFromSession,
  PROACTIVE_WEB_TASK_PREFIX,
} from "./proactiveRalphTasks.ts"
import { evaluateTopLevelRalphGate } from "./topLevelRalphGate.ts"

const root = mkdtempSync(join(tmpdir(), "monolito-proactive-ralph-"))
process.env.MONOLITO_ROOT = root

test.after(() => {
  rmSync(root, { recursive: true, force: true })
})

test("isLiveWebDataRequest detects weather questions", () => {
  assert.equal(isLiveWebDataRequest("cual es el clima mañana en Santo Tomé"), true)
  assert.equal(isLiveWebDataRequest("hola como estas"), false)
})

test("seedLiveWebProactiveTasksFromSession creates Ralph tasks before model turn", () => {
  writeConfigWing(root, "CONF_WEBSEARCH", { provider: "brave", apiKey: "test-key" })
  const seeded = seedLiveWebProactiveTasksFromSession(
    root,
    "orchestrator",
    "default",
    [{ role: "user", text: "cual es el clima mañana", at: new Date().toISOString() }],
    "vivo en Santo Tomé Santa Fe",
  )
  assert.equal(seeded, true)
  const tasks = listSessionTasks(root, "orchestrator", "default")
  assert.ok(tasks.some(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}search`))
  assert.ok(tasks.some(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}reply`))
})

test("Ralph blocks delivery while proactive web tasks are open", () => {
  writeConfigWing(root, "CONF_WEBSEARCH", { provider: "brave", apiKey: "test-key" })
  seedLiveWebProactiveTasksFromSession(
    root,
    "orch-2",
    "default",
    [{ role: "user", text: "clima mañana", at: new Date().toISOString() }],
    "clima mañana",
  )
  const taskIds = new Set(
    listSessionTasks(root, "orch-2", "default")
      .filter(t => t.status === "pending" || t.status === "in_progress")
      .map(t => t.id),
  )
  const result = evaluateTopLevelRalphGate(
    root,
    "orch-2",
    "default",
    "clima mañana",
    1,
    "No puedo buscar",
    [],
    [],
    taskIds,
  )
  assert.equal(result.blocked, true)
  assert.ok(result.unfinished.length > 0)
})

test("advanceProactiveTasksOnToolSuccess completes search task after Web", () => {
  writeConfigWing(root, "CONF_WEBSEARCH", { provider: "brave", apiKey: "test-key" })
  seedLiveWebProactiveTasksFromSession(
    root,
    "orch-3",
    "default",
    [{ role: "user", text: "clima", at: new Date().toISOString() }],
    "clima",
  )
  advanceProactiveTasksOnToolSuccess(
    root,
    "orch-3",
    "default",
    "Web",
    { action: "search", query: "clima" },
    { ok: true, results: [] },
  )
  const search = listSessionTasks(root, "orch-3", "default").find(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}search`)
  assert.equal(search?.status, "completed")
})
