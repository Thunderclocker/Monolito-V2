// Proactive Ralph: the runtime seeds cognitive tasks (active_tasks.json) when it
// detects multi-step user intent. The top-level Ralph loop then blocks delivery
// until those tasks are completed — proactivity via the task list, not post-hoc guards.

import { looksLikeUserMessageEcho } from "./providers/utils.ts"
import { readWebSearchConfigAt } from "../websearch/config.ts"
import {
  deleteSessionTask,
  listSessionTasks,
  writeSessionTask,
  type SessionTask,
} from "../session/store.ts"
import type { SessionRecord } from "../ipc/protocol.ts"

export const PROACTIVE_WEB_TASK_PREFIX = "ralph-proactive-web-"

const WEB_SEARCH_TOOLS = new Set(["Web", "WebSearch", "WebFetch"])

export function isLiveWebDataRequest(text: string): boolean {
  if (!text) return false
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  return /\b(clima|weather|pronostico|forecast|tiempo|noticias|news|precio|cotizacion|buscar|search|como esta el tiempo)\b/.test(normalized)
}

export function isWeatherRequest(text: string): boolean {
  if (!text) return false
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  return /\b(clima|weather|pronostico|forecast|tiempo|como esta el tiempo)\b/.test(normalized)
}

export function hasLocationContext(text: string): boolean {
  if (!text) return false
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  return /\b(vivo en|soy de|estoy en|ubicado en|mi ciudad|localidad)\b/.test(normalized)
    || /\b(argentina|santa fe|buenos aires|cordoba|c[oó]rdoba|rosario|mendoza|santo tom[eé]|santo tome)\b/.test(normalized)
    || /\ben\s+[a-záéíóúñ]{3,}(?:,\s*[a-záéíóúñ]{3,}){0,2}\b/i.test(text)
}

export function userProvidedApiKeyHint(text: string): boolean {
  return /\b(api\s*key|la\s+api|api\s+es|brave|tvly-)\b/i.test(text)
    || /\bBSA[A-Za-z0-9_-]{18,}\b/.test(text)
    || /\btvly-[A-Za-z0-9_-]{10,}\b/i.test(text)
}

export function buildLiveWebUserContext(
  messages: SessionRecord["messages"],
  currentUserText: string,
  maxUserMessages = 4,
): string {
  const recentUser = messages
    .filter(m => m.role === "user")
    .slice(-maxUserMessages)
    .map(m => m.text)
  return [...recentUser, currentUserText].join("\n")
}

export function shouldSeedLiveWebProactiveTasks(
  userContext: string,
  messages: SessionRecord["messages"],
): boolean {
  if (isLiveWebDataRequest(userContext)) return true
  if (!userProvidedApiKeyHint(userContext)) return false
  return messages.some(m => m.role === "user" && isLiveWebDataRequest(m.text))
}

export function isGenericDeferralReply(reply: string): boolean {
  const n = reply.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  return /\b(en que puedo ayud|asistirte hoy|hola[!,?]|buen(?:os)? dias|good morning)\b/.test(n)
    || /\b(entiendo el comentario|procedere segun|continuare con las tareas|tareas pendientes|informare cuando se complete)\b/.test(n)
    || /\b(lo hare mas tarde|vuelvo con|en un momento te)\b/.test(n)
}

export function isLocationClarificationReply(reply: string): boolean {
  const n = reply.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  return /\?/.test(reply)
    && /\b(donde|ubicacion|ciudad|localidad|zona|lugar|region)\b/.test(n)
}

export function isSubstantiveWeatherReply(reply: string): boolean {
  if (isGenericDeferralReply(reply)) return false
  const n = reply.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  return /\b(\d+\s*°|grados|mm\b|pronostico|despejado|nublado|lluvia|tormenta|maxima|minima|humedad|viento|parcialmente|soleado|frio|calor|celsius)\b/.test(n)
    || (/\bmañana\b/.test(n) && /\b(temp|tiempo|clima|weather)\b/.test(n))
}

export function isSubstantiveProactiveWebReply(userContext: string, reply: string): boolean {
  const trimmed = reply.trim()
  if (trimmed.length < 15 || looksLikeUserMessageEcho(trimmed, userContext)) return false
  if (isGenericDeferralReply(trimmed)) return false

  if (isWeatherRequest(userContext)) {
    if (!hasLocationContext(userContext)) {
      return isLocationClarificationReply(trimmed)
    }
    return isSubstantiveWeatherReply(trimmed)
  }

  return trimmed.length >= 40
}

function clearProactiveWebTasks(rootDir: string, sessionId: string, profileId: string) {
  for (const task of listSessionTasks(rootDir, sessionId, profileId)) {
    if (task.id.startsWith(PROACTIVE_WEB_TASK_PREFIX)) {
      deleteSessionTask(rootDir, sessionId, task.id, profileId)
    }
  }
}

function upsertProactiveTask(
  rootDir: string,
  sessionId: string,
  profileId: string,
  task: SessionTask,
) {
  writeSessionTask(rootDir, sessionId, task.id, task, profileId)
}

function patchProactiveTask(
  rootDir: string,
  sessionId: string,
  profileId: string,
  taskId: string,
  patch: Partial<Pick<SessionTask, "status" | "activeForm">>,
) {
  const existing = listSessionTasks(rootDir, sessionId, profileId).find(t => t.id === taskId)
  if (!existing) return
  upsertProactiveTask(rootDir, sessionId, profileId, {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  })
}

function promoteFirstPendingWebTask(rootDir: string, sessionId: string, profileId: string) {
  const order = [
    `${PROACTIVE_WEB_TASK_PREFIX}location`,
    `${PROACTIVE_WEB_TASK_PREFIX}config`,
    `${PROACTIVE_WEB_TASK_PREFIX}search`,
    `${PROACTIVE_WEB_TASK_PREFIX}reply`,
  ]
  const tasks = listSessionTasks(rootDir, sessionId, profileId)
  const hasInProgress = tasks.some(t => t.id.startsWith(PROACTIVE_WEB_TASK_PREFIX) && t.status === "in_progress")
  if (hasInProgress) return
  for (const id of order) {
    const task = tasks.find(t => t.id === id && t.status === "pending")
    if (task) {
      patchProactiveTask(rootDir, sessionId, profileId, id, { status: "in_progress" })
      return
    }
  }
}

/** Seed Ralph cognitive tasks before the model turn (included in preExistingTaskIds). */
export function seedLiveWebProactiveTasks(
  rootDir: string,
  sessionId: string,
  profileId: string,
  userContext: string,
): boolean {
  const webReady = readWebSearchConfigAt(rootDir).provider !== "default"
  const weather = isWeatherRequest(userContext)
  const hasLocation = hasLocationContext(userContext)
  const needsLocationFirst = weather && !hasLocation

  clearProactiveWebTasks(rootDir, sessionId, profileId)
  const now = new Date().toISOString()

  if (!webReady) {
    upsertProactiveTask(rootDir, sessionId, profileId, {
      id: `${PROACTIVE_WEB_TASK_PREFIX}config`,
      sessionId,
      content: "Configurar CONF_WEBSEARCH con tool_manage_config (provider + apiKey) para habilitar búsqueda web",
      activeForm: "Configurando búsqueda web",
      status: "in_progress",
      createdAt: now,
      category: "cognitive",
    })
  }

  if (needsLocationFirst) {
    upsertProactiveTask(rootDir, sessionId, profileId, {
      id: `${PROACTIVE_WEB_TASK_PREFIX}location`,
      sessionId,
      content: "Confirmar ciudad/zona del usuario (BOOT_USER o preguntar ubicación antes de buscar clima genérico)",
      activeForm: "Confirmando ubicación para el clima",
      status: "in_progress",
      createdAt: now,
      category: "cognitive",
    })
  }

  upsertProactiveTask(rootDir, sessionId, profileId, {
    id: `${PROACTIVE_WEB_TASK_PREFIX}search`,
    sessionId,
    content: needsLocationFirst
      ? "Consultar Web (action=search) con ciudad + clima mañana cuando tengas ubicación"
      : "Consultar Web (action=search) con la consulta del usuario",
    activeForm: "Buscando información en la web",
    status: needsLocationFirst || !webReady ? "pending" : "in_progress",
    createdAt: now,
    category: "cognitive",
  })

  upsertProactiveTask(rootDir, sessionId, profileId, {
    id: `${PROACTIVE_WEB_TASK_PREFIX}reply`,
    sessionId,
    content: needsLocationFirst
      ? "Preguntar ubicación O responder con el pronóstico concreto (temperaturas, condiciones)"
      : "Responder al usuario con la información obtenida (sin repetir API keys)",
    activeForm: "Redactando respuesta al usuario",
    status: "pending",
    createdAt: now,
    category: "cognitive",
  })

  return true
}

export function seedLiveWebProactiveTasksFromSession(
  rootDir: string,
  sessionId: string,
  profileId: string,
  messages: SessionRecord["messages"],
  currentUserText: string,
): boolean {
  const context = buildLiveWebUserContext(messages, currentUserText)
  if (!shouldSeedLiveWebProactiveTasks(context, messages)) return false
  return seedLiveWebProactiveTasks(rootDir, sessionId, profileId, context)
}

/** When the user provides location in a follow-up, advance the location task. */
export function resolveProactiveLocationFromUserMessage(
  rootDir: string,
  sessionId: string,
  profileId: string,
  userText: string,
) {
  if (!hasLocationContext(userText)) return
  const locationId = `${PROACTIVE_WEB_TASK_PREFIX}location`
  const locationTask = listSessionTasks(rootDir, sessionId, profileId).find(t => t.id === locationId)
  if (!locationTask || locationTask.status === "completed") return
  patchProactiveTask(rootDir, sessionId, profileId, locationId, { status: "completed" })
  promoteFirstPendingWebTask(rootDir, sessionId, profileId)
}

function isWebSearchConfigSuccess(tool: string, input: Record<string, unknown>, output: unknown): boolean {
  if (tool !== "tool_manage_config") return false
  const rec = output && typeof output === "object" ? output as Record<string, unknown> : {}
  if (rec.ok !== true) return false
  const config = input.config ?? input.wing
  const path = input.path
  return config === "CONF_WEBSEARCH" && (path === "apiKey" || path === "provider" || path === undefined)
}

function isWebSearchSuccess(tool: string, output: unknown): boolean {
  if (!WEB_SEARCH_TOOLS.has(tool)) return false
  const rec = output && typeof output === "object" ? output as Record<string, unknown> : {}
  return rec.ok !== false && !rec.error
}

function proactiveWebSearchCompleted(rootDir: string, sessionId: string, profileId: string): boolean {
  const search = listSessionTasks(rootDir, sessionId, profileId)
    .find(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}search`)
  return search?.status === "completed"
}

/** Advance proactive tasks when tools produce evidence (called from executeTool). */
export function advanceProactiveTasksOnToolSuccess(
  rootDir: string,
  sessionId: string,
  profileId: string,
  tool: string,
  input: Record<string, unknown>,
  output: unknown,
) {
  const configId = `${PROACTIVE_WEB_TASK_PREFIX}config`
  const searchId = `${PROACTIVE_WEB_TASK_PREFIX}search`
  const replyId = `${PROACTIVE_WEB_TASK_PREFIX}reply`

  if (isWebSearchConfigSuccess(tool, input, output)) {
    patchProactiveTask(rootDir, sessionId, profileId, configId, { status: "completed" })
    promoteFirstPendingWebTask(rootDir, sessionId, profileId)
  } else {
    const configTask = listSessionTasks(rootDir, sessionId, profileId).find(t => t.id === configId)
    if (configTask && configTask.status !== "completed" && readWebSearchConfigAt(rootDir).provider !== "default") {
      patchProactiveTask(rootDir, sessionId, profileId, configId, { status: "completed" })
      promoteFirstPendingWebTask(rootDir, sessionId, profileId)
    }
  }

  if (isWebSearchSuccess(tool, output)) {
    const locationId = `${PROACTIVE_WEB_TASK_PREFIX}location`
    const locationTask = listSessionTasks(rootDir, sessionId, profileId).find(t => t.id === locationId)
    if (locationTask && locationTask.status !== "completed") {
      patchProactiveTask(rootDir, sessionId, profileId, locationId, { status: "completed" })
    }
    patchProactiveTask(rootDir, sessionId, profileId, searchId, { status: "completed" })
    patchProactiveTask(rootDir, sessionId, profileId, replyId, { status: "in_progress" })
  }
}

/** Mark reply task done only when the assistant actually answered the user's request. */
export function finalizeProactiveWebTasksBeforeRalph(
  rootDir: string,
  sessionId: string,
  profileId: string,
  turnSteps: Array<{ type?: string; tool?: string }>,
  assistantReply: string,
  userContext: string,
) {
  const replyId = `${PROACTIVE_WEB_TASK_PREFIX}reply`
  const replyTask = listSessionTasks(rootDir, sessionId, profileId).find(t => t.id === replyId)
  if (!replyTask || replyTask.status === "completed") return

  const ranWeb = turnSteps.some(s => s.type === "tool" && typeof s.tool === "string" && WEB_SEARCH_TOOLS.has(s.tool))
  const reply = assistantReply.trim()

  if (isWeatherRequest(userContext) && !hasLocationContext(userContext)) {
    if (isLocationClarificationReply(reply)) {
      patchProactiveTask(rootDir, sessionId, profileId, replyId, { status: "completed" })
    }
    return
  }

  if (!ranWeb && !proactiveWebSearchCompleted(rootDir, sessionId, profileId)) return
  if (!isSubstantiveProactiveWebReply(userContext, reply)) return

  patchProactiveTask(rootDir, sessionId, profileId, replyId, { status: "completed" })
}

/** Extra Ralph guidance when the model defers instead of synthesizing Web results. */
export function enrichProactiveWebRalphFeedback(
  feedbackPrompt: string | null,
  rootDir: string,
  sessionId: string,
  profileId: string,
  userContext: string,
  assistantReply: string,
): string | null {
  if (!feedbackPrompt) return feedbackPrompt
  const replyTask = listSessionTasks(rootDir, sessionId, profileId)
    .find(t => t.id === `${PROACTIVE_WEB_TASK_PREFIX}reply`)
  if (!replyTask || replyTask.status === "completed") return feedbackPrompt
  if (!proactiveWebSearchCompleted(rootDir, sessionId, profileId)) return feedbackPrompt

  const lines = [feedbackPrompt, ""]
  if (isGenericDeferralReply(assistantReply)) {
    lines.push(
      "Ya ejecutaste Web y tenés resultados en el historial del turno.",
      "Respondé AHORA al usuario con el pronóstico concreto (temperaturas, condiciones, mañana).",
      "Prohibido saludar, posponer ('continuaré con las tareas'), o hablar del proceso interno.",
    )
  } else if (isWeatherRequest(userContext) && hasLocationContext(userContext)) {
    lines.push(
      "Falta la respuesta final con el clima. Sintetizá los resultados de Web en español:",
      "temperatura mín/máx, condición (soleado/nublado/lluvia) y fecha (mañana).",
    )
  }
  return lines.join("\n")
}
