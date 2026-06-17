import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listSessionTasks, writeConfigWing } from "../session/store.ts"
import {
  advanceProactiveTasksOnToolSuccess,
  finalizeProactiveWebTasksBeforeRalph,
  isGenericDeferralReply,
  isLiveWebDataRequest,
  isSubstantiveWeatherReply,
  seedLiveWebProactiveTasksFromSession,
  PROACTIVE_WEB_TASK_PREFIX,
  resolveProactiveLocationFromUserMessage,
} from "./proactiveRalphTasks.ts"
import { evaluateTopLevelRalphGate } from "./topLevelRalphGate.ts"

const root = mkdtempSync(join(tmpdir(), "monolito-proactive-ralph-"))
process.env.MONOLITO_ROOT = root

test.after(() => {
  rmSync(root, { recursive: true, force: true })
})

test("isLiveWebDataRequest detects weather questions", () => {
  assert.equal(isLiveWebDataRequest("cual es el clima mañana"), true)
  assert.equal(isLiveWebDataRequest("hola como estas"), false)
})

test("seedLiveWebProactiveTasksFromSession adds location task when weather has no city", () => {
  writeConfigWing(root, "CONF_WEBSEARCH", { provider: "brave", apiKey: "test-key" })
  seedLiveWebProactiveTasksFromSession(
    root,
    "orch-loc",
    "default",
    [],
    "cual es el clima para mañana",
  )
  const tasks = listSessionTasks(root, "orch-loc", "default")
  assert.ok(tasks.some(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}location`))
  const search = tasks.find(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}search`)
  assert.equal(search?.status, "pending")
})

test("seedLiveWebProactiveTasksFromSession starts Web when location is known", () => {
  writeConfigWing(root, "CONF_WEBSEARCH", { provider: "brave", apiKey: "test-key" })
  seedLiveWebProactiveTasksFromSession(
    root,
    "orch-loc2",
    "default",
    [{ role: "user", text: "cual es el clima mañana", at: new Date().toISOString() }],
    "vivo en Santo Tome Santa Fe Argentina",
  )
  const tasks = listSessionTasks(root, "orch-loc2", "default")
  assert.equal(tasks.some(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}location`), false)
  const search = tasks.find(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}search`)
  assert.equal(search?.status, "in_progress")
})

test("finalizeProactiveWebTasksBeforeRalph rejects deferral replies after Web", () => {
  writeConfigWing(root, "CONF_WEBSEARCH", { provider: "brave", apiKey: "test-key" })
  seedLiveWebProactiveTasksFromSession(root, "orch-rej", "default", [], "clima mañana Santo Tomé")
  advanceProactiveTasksOnToolSuccess(root, "orch-rej", "default", "Web", { action: "search" }, { ok: true })
  finalizeProactiveWebTasksBeforeRalph(
    root,
    "orch-rej",
    "default",
    [{ type: "tool", tool: "Web" }],
    "Entiendo el comentario y procederé según lo indicado.",
    "clima mañana Santo Tomé",
  )
  const reply = listSessionTasks(root, "orch-rej", "default").find(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}reply`)
  assert.notEqual(reply?.status, "completed")
  assert.equal(isGenericDeferralReply("¡Hola! ¿En qué puedo asistirte hoy?"), true)
})

test("finalizeProactiveWebTasksBeforeRalph accepts substantive weather reply", () => {
  writeConfigWing(root, "CONF_WEBSEARCH", { provider: "brave", apiKey: "test-key" })
  seedLiveWebProactiveTasksFromSession(
    root,
    "orch-ok",
    "default",
    [],
    "clima mañana Santo Tomé Santa Fe",
  )
  advanceProactiveTasksOnToolSuccess(root, "orch-ok", "default", "Web", { action: "search" }, { ok: true })
  const answer = "Mañana en Santo Tomé: mínima 15°C, máxima 24°C, parcialmente nublado."
  assert.equal(isSubstantiveWeatherReply(answer), true)
  finalizeProactiveWebTasksBeforeRalph(
    root,
    "orch-ok",
    "default",
    [{ type: "tool", tool: "Web" }],
    answer,
    "clima mañana Santo Tomé Santa Fe",
  )
  const reply = listSessionTasks(root, "orch-ok", "default").find(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}reply`)
  assert.equal(reply?.status, "completed")
})

test("resolveProactiveLocationFromUserMessage completes location task", () => {
  writeConfigWing(root, "CONF_WEBSEARCH", { provider: "brave", apiKey: "test-key" })
  seedLiveWebProactiveTasksFromSession(root, "orch-res", "default", [], "cual es el clima mañana")
  resolveProactiveLocationFromUserMessage(root, "orch-res", "default", "vivo en Santo Tome Santa Fe Argentina")
  const location = listSessionTasks(root, "orch-res", "default").find(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}location`)
  assert.equal(location?.status, "completed")
  const search = listSessionTasks(root, "orch-res", "default").find(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}search`)
  assert.equal(search?.status, "in_progress")
})

test("Ralph blocks delivery while proactive web tasks are open", () => {
  writeConfigWing(root, "CONF_WEBSEARCH", { provider: "brave", apiKey: "test-key" })
  seedLiveWebProactiveTasksFromSession(
    root,
    "orch-2",
    "default",
    [{ role: "user", text: "clima mañana", at: new Date().toISOString() }],
    "clima mañana Santo Tomé",
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
    "clima mañana Santo Tomé",
    1,
    "No puedo buscar",
    [],
    [],
    taskIds,
  )
  assert.equal(result.blocked, true)
  assert.ok(result.unfinished.length > 0)
})
