import { execFile } from "node:child_process"
import { existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { getPaths, type AgentEvent, type SessionRecord } from "../ipc/protocol.ts"
import { StdioMcpClient, getDefaultMcpServers } from "../mcp/client.ts"
import {
  appendActionLog,
  appendEvent,
  appendMessage,
  appendWorklog,
  compactSession,
  ensureConfigWings,
  ensureBootWings,
  ensureSession,
  getSession,
  getSessionStats,
  listSessions,
  recoverRunningSessions,
  resetSession,
  setSessionState,
  tailEvents,
  updateSessionProfile,
  listProfiles,
  createProfile,
  getDb,
} from "../session/store.ts"
import { getTool, listTools, type ToolContext } from "../tools/registry.ts"
import { getEffectiveModelConfig, runAssistantTurn, runBackgroundTextTask } from "./modelAdapter.ts"
import {
  applyModelSettingsToEnv,
  draftToSettings,
  loadAndApplyModelSettings,
  maskApiKey,
  readModelSettings,
  redactSensitiveModelSettings,
  saveModelSettings,
  settingsToDraft,
  validateModelDraft,
} from "./modelConfig.ts"
import { MODEL_PROTOCOL } from "./modelConstants.ts"
import { createCostState, recordApiCall, recordToolCall, formatCostSummary } from "../cost/tracker.ts"
import { readChannelsConfig, writeChannelsConfig } from "../channels/config.ts"
import { readWebSearchConfig, writeWebSearchConfig, type WebSearchProvider } from "../websearch/config.ts"
import { getDateContext, getGitContext } from "../context/gitContext.ts"
import { getWorkspaceContext } from "../context/workspaceContext.ts"
import { normalizeToolInputPayload } from "./toolInput.ts"
import { AgentOrchestrator } from "./orchestrator.ts"
import { renderToolFinish, renderToolStart, renderToolStartText } from "../renderer/toolRenderer.ts"
import { checkToolPermission, runPostToolHooks } from "./permissions.ts"
import { runMemoryAgentReview } from "./memoryAgent.ts"
import type { Logger } from "../logging/logger.ts"
import type { DelegationTask } from "./orchestrator.ts"
import {
  deployManagedTtsContainer,
  getManagedTtsBaseUrl,
  getManagedTtsStatus,
  listManagedTtsContainers,
  normalizeTtsConfig,
  removeManagedTtsContainer,
  stopManagedTtsContainer,
} from "../tts/managed.ts"
import {
  deployManagedSttContainer,
  getManagedSttBaseUrl,
  getManagedSttStatus,
  listManagedSttContainers,
  normalizeSttConfig,
  removeManagedSttContainer,
  stopManagedSttContainer,
} from "../stt/managed.ts"
import { MONOLITO_ROOT } from "../system/root.ts"
import { ToolExecutionError } from "../errors.ts"

type EventListener = (event: AgentEvent) => void

type SessionBusyError = Error & {
  code: "SESSION_BUSY"
}

type TelegramTypingIndicator = {
  stop(): void
}

const execFileAsync = promisify(execFile)
const SEARXNG_CONTAINER = "monolito-searxng"
const SEARXNG_PORT = 8888
const SEARXNG_URL = `http://127.0.0.1:${SEARXNG_PORT}`
const SEARXNG_SETTINGS_DIR = join(MONOLITO_ROOT, "searxng")
const SEARXNG_SETTINGS_FILE = join(SEARXNG_SETTINGS_DIR, "settings.yml")
const TELEGRAM_TYPING_REFRESH_MS = 4_000
const TURN_HARD_TIMEOUT_MS = 95_000
const COMMAND_REPAIR_MAX_ATTEMPTS = 3
const STALL_ALERT_MESSAGE = "SYSTEM ALERT: STALL DETECTED. You have hit the exact same tool execution error twice. Evaluate your remaining viable strategies. If you have a logically distinct path, execute it now. If you have EXHAUSTED ALL viable paths, you MUST format your response to yield control back to the user, summarizing what you tried and why it failed."

class TurnTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TurnTimeoutError"
  }
}

type SearxngContainerInfo = {
  id: string
  name: string
  image: string
  status: string
  isOurs: boolean
}

function createSessionBusyError(sessionId: string): SessionBusyError {
  const error = new Error(`Session ${sessionId} is already busy with another running turn.`) as SessionBusyError
  error.code = "SESSION_BUSY"
  return error
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function truncateFailureDetail(value: string, max = 240) {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1).trimEnd()}...`
}

function webSearchProviderLabel(provider: WebSearchProvider) {
  switch (provider) {
    case "default":
      return "default"
    case "searxng":
      return "searxng"
  }
}

async function findAllSearxngContainers(): Promise<SearxngContainerInfo[]> {
  try {
    const { stdout: byImage } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", "ancestor=searxng/searxng",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
    ], { timeout: 10_000 })
    const { stdout: byName } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", "name=searxng",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
    ], { timeout: 10_000 })

    const seen = new Set<string>()
    const containers: SearxngContainerInfo[] = []
    for (const line of [...byImage.trim().split("\n"), ...byName.trim().split("\n")]) {
      if (!line.trim()) continue
      const [id, name, image, status] = line.split("\t")
      if (!id || seen.has(id)) continue
      seen.add(id)
      containers.push({
        id: id.slice(0, 12),
        name: name ?? "",
        image: image ?? "",
        status: status ?? "",
        isOurs: name === SEARXNG_CONTAINER,
      })
    }
    return containers
  } catch {
    return []
  }
}

async function getSearxngStatus(): Promise<"running" | "stopped" | "not_found" | "docker_error"> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", `name=^/${SEARXNG_CONTAINER}$`,
      "--format", "{{.Status}}",
    ], { timeout: 10_000 })
    const status = stdout.trim()
    if (!status) return "not_found"
    return status.startsWith("Up") ? "running" : "stopped"
  } catch {
    return "docker_error"
  }
}

function withManagedSearxngSettings(content: string) {
  let updated = content
  if (!/^\s*-\s*json\s*$/m.test(updated)) {
    updated = updated.replace(/(^\s*formats:\n(?:\s*#.*\n)*\s*-\s*html\s*$)/m, `$1\n    - json`)
  }
  if (/^\s*safe_search:\s*0\s*$/m.test(updated)) return updated
  if (/^\s*safe_search:\s*\d+\s*$/m.test(updated)) {
    return updated.replace(/^(\s*safe_search:\s*)\d+\s*$/m, (_, prefix: string) => `${prefix}0`)
  }
  if (/^\s*search:\s*$/m.test(updated)) {
    return updated.replace(/^(\s*search:\s*)$/m, "$1\n  safe_search: 0")
  }
  return updated
}

async function ensureSearxngSettingsFile(): Promise<{ ok: boolean; message?: string }> {
  mkdirSync(SEARXNG_SETTINGS_DIR, { recursive: true })
  if (existsSync(SEARXNG_SETTINGS_FILE)) {
    const current = readFileSync(SEARXNG_SETTINGS_FILE, "utf8")
    const updated = withManagedSearxngSettings(current)
    if (updated !== current) writeFileSync(SEARXNG_SETTINGS_FILE, updated, "utf8")
    if (/^\s*-\s*json\s*$/m.test(updated) && /^\s*safe_search:\s*0\s*$/m.test(updated)) return { ok: true }
  }

  const bootstrapContainer = `${SEARXNG_CONTAINER}-bootstrap`
  let createdBootstrap = false
  try {
    const status = await getSearxngStatus()
    if (status === "not_found") {
      await execFileAsync("docker", ["run", "-d", "--name", bootstrapContainer, "searxng/searxng:latest"], { timeout: 60_000 })
      createdBootstrap = true
      await new Promise(resolve => setTimeout(resolve, 3000))
      await execFileAsync("docker", ["cp", `${bootstrapContainer}:/etc/searxng/settings.yml`, SEARXNG_SETTINGS_FILE], { timeout: 15_000 })
    } else {
      await execFileAsync("docker", ["cp", `${SEARXNG_CONTAINER}:/etc/searxng/settings.yml`, SEARXNG_SETTINGS_FILE], { timeout: 15_000 })
    }
    const updated = withManagedSearxngSettings(readFileSync(SEARXNG_SETTINGS_FILE, "utf8"))
    writeFileSync(SEARXNG_SETTINGS_FILE, updated, "utf8")
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `No se pudo preparar settings.yml de SearxNG: ${message}` }
  } finally {
    if (createdBootstrap) {
      await execFileAsync("docker", ["rm", "-f", bootstrapContainer], { timeout: 15_000 }).catch(() => {})
    }
  }
}

async function probeSearxngJsonApi() {
  try {
    const response = await fetch(`${SEARXNG_URL}/search?q=mountains&categories=images&format=json`, {
      signal: AbortSignal.timeout(5000),
    })
    return response.ok
  } catch {
    return false
  }
}

async function listSearxngContainers(): Promise<string> {
  const containers = await findAllSearxngContainers()
  if (containers.length === 0) return "No se encontraron contenedores SearxNG."
  return [
    `Contenedores SearxNG encontrados: ${containers.length}`,
    ...containers.map(container =>
      `- ${container.name || "(sin nombre)"} | ${container.id} | ${container.image} | ${container.status}${container.isOurs ? " | managed" : ""}`),
  ].join("\n")
}

async function removeSearxngContainer(idOrName: string): Promise<{ ok: boolean; message: string }> {
  if (idOrName === SEARXNG_CONTAINER) {
    const containers = await findAllSearxngContainers()
    const ours = containers.find(container => container.isOurs)
    if (!ours) {
      return { ok: true, message: "SearxNG no está desplegado." }
    }
    idOrName = ours.id
  }
  try {
    await execFileAsync("docker", ["rm", "-f", idOrName], { timeout: 15_000 })
    return { ok: true, message: `Contenedor ${idOrName} eliminado.` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Error eliminando ${idOrName}: ${message}` }
  }
}

async function stopSearxngContainer(): Promise<{ ok: boolean; message: string }> {
  const status = await getSearxngStatus()
  if (status === "not_found" || status === "docker_error") {
    return { ok: true, message: "SearxNG no está desplegado." }
  }
  try {
    await execFileAsync("docker", ["stop", SEARXNG_CONTAINER], { timeout: 15_000 })
    return { ok: true, message: "SearxNG detenido." }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Error deteniendo SearxNG: ${message}` }
  }
}

async function clearAllSearxngContainers(): Promise<{ ok: boolean; message: string }> {
  const containers = await findAllSearxngContainers()
  if (containers.length === 0) return { ok: true, message: "No se encontraron contenedores SearxNG." }
  const lines: string[] = []
  let allOk = true
  for (const container of containers) {
    const result = await removeSearxngContainer(container.id)
    lines.push(`${container.name || container.id}: ${result.ok ? "eliminado" : result.message}`)
    if (!result.ok) allOk = false
  }
  return { ok: allOk, message: lines.join("\n") }
}

async function deploySearxngContainer(): Promise<{ ok: boolean; message: string }> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 })
  } catch {
    return { ok: false, message: "Docker no está disponible o no está corriendo." }
  }

  const status = await getSearxngStatus()
  if (status === "running") {
    try {
      const probe = await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(3000) })
      if (probe.ok && await probeSearxngJsonApi()) return { ok: true, message: `SearxNG ya está corriendo en ${SEARXNG_URL}.` }
    } catch {}
  }

  const settings = await ensureSearxngSettingsFile()
  if (!settings.ok) {
    return { ok: false, message: settings.message ?? "No se pudo preparar la configuración de SearxNG." }
  }

  const containers = await findAllSearxngContainers()
  for (const container of containers.filter(item => !item.isOurs)) {
    await removeSearxngContainer(container.id)
  }

  if (status === "running" || status === "stopped") {
    await removeSearxngContainer(SEARXNG_CONTAINER)
  }

  try {
    await execFileAsync("docker", [
      "run", "-d",
      "--name", SEARXNG_CONTAINER,
      "-p", `127.0.0.1:${SEARXNG_PORT}:8080`,
      "--restart", "unless-stopped",
      "-v", `${SEARXNG_SETTINGS_FILE}:/etc/searxng/settings.yml:ro`,
      "searxng/searxng:latest",
    ], { timeout: 120_000 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Error desplegando SearxNG: ${message}` }
  }

  for (let i = 0; i < 25; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    try {
      const probe = await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(2000) })
      if (probe.ok && await probeSearxngJsonApi()) return { ok: true, message: `SearxNG desplegado en ${SEARXNG_URL}.` }
    } catch {}
  }

  return { ok: false, message: "SearxNG se inició pero su API JSON no respondió dentro de 25s." }
}

async function testSearxngQuery(query: string): Promise<string> {
  const encoded = encodeURIComponent(query)
  const response = await fetch(`${SEARXNG_URL}/search?q=${encoded}&format=json`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    return `SearxNG respondió HTTP ${response.status}.`
  }
  const data = await response.json() as { results?: Array<{ title?: string; url?: string }> }
  const results = (data.results ?? []).slice(0, 5)
  if (results.length === 0) return `Búsqueda "${query}": 0 resultados.`
  return [
    `Búsqueda "${query}": ${results.length} resultados.`,
    ...results.map((result, index) => `${index + 1}. ${result.title ?? "(sin título)"}\n${result.url ?? ""}`),
  ].join("\n")
}

function parseAllowedChats(input: string) {
  const ids = input.split(",").map(item => item.trim()).filter(Boolean).map(Number)
  const invalid = ids.filter(item => !Number.isFinite(item) || item === 0)
  return { ids, invalid }
}

function getToolFailureMessage(toolName: string, output: unknown) {
  if (toolName !== "Bash") return null
  const value = asRecord(output)
  if (!value) return null
  const exitCode = typeof value.exitCode === "number" ? value.exitCode : null
  const stderr = typeof value.stderr === "string" ? value.stderr : ""
  if (exitCode !== null && exitCode !== 0) {
    return `Command exited ${exitCode}${stderr.trim() ? `: ${truncateFailureDetail(stderr)}` : ""}`
  }
  if (/(sudo:|se requiere una contraseña|a terminal is required|operaci[oó]n no permitida|operation not permitted|permission denied|kill:.*failed)/i.test(stderr)) {
    return `Command reported a permission/error condition: ${truncateFailureDetail(stderr)}`
  }
  return null
}

function getBashExecutionDetails(output: unknown) {
  const value = asRecord(output)
  if (!value) return null
  return {
    command: typeof value.command === "string" ? value.command : "",
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    stdout: typeof value.stdout === "string" ? value.stdout : "",
    stderr: typeof value.stderr === "string" ? value.stderr : "",
  }
}

function buildToolExecutionError(toolName: string, output: unknown) {
  const failure = getToolFailureMessage(toolName, output)
  if (!failure) return null
  const details = getBashExecutionDetails(output)
  return new ToolExecutionError(
    failure,
    details?.command,
    details?.exitCode,
    details?.stdout ?? "",
    details?.stderr ?? "",
    output,
  )
}

function extractRepairedCommand(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return ""

  const fencedMatch = trimmed.match(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/i)
  let candidate = (fencedMatch?.[1] ?? trimmed).trim()
  if (!candidate) return ""

  candidate = candidate.replace(/^\s*`{1,3}/, "").replace(/`{1,3}\s*$/, "").trim()
  if (!candidate) return ""

  const lines = candidate
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)

  const isCommandLike = (line: string) => {
    const cleaned = line.replace(/^[-*+\d.]+\s+/, "")
    if (/^```/.test(cleaned)) return false
    if (/^(explanation|reason|because|note|notes|analysis|output|command:)/i.test(cleaned)) return false
    if (/^(model request failed|tool_call_error|cannot |can't |error:|failed:|timeout|timed out\b)/i.test(cleaned)) return false
    return /^(sudo\s+)?[a-zA-Z0-9_.-]+(\s+|$)/.test(cleaned)
  }

  const commandLine = lines.find(isCommandLike)
  const normalized = commandLine?.replace(/^[-*+\d.]+\s+/, "").trim() ?? ""
  if (/^(model request failed|tool_call_error|cannot |can't |error:|failed:|timeout|timed out\b)/i.test(normalized)) {
    return ""
  }
  return normalized
}

function buildCommandRepairSystemPrompt(command: string, exitCode: number | null | undefined, stderr: string) {
  return [
    "You are the internal CommandRepairLoop for Monolito V2.",
    `The command \`${command || "(missing command)"}\` failed with exit code ${exitCode ?? "unknown"}.`,
    stderr.trim() ? `stderr:\n${stderr.trim().slice(0, 2000)}` : "stderr:\n(no stderr)",
    "Analyze the failure and output exactly one corrected shell command.",
    "Use only a shell command. Do not apologize. Do not explain. Do not use markdown unless the command must be in a fenced block.",
    "Do not ask the user for help. Prefer the smallest safe correction that preserves the original intent.",
  ].join("\n\n")
}

function outputWithError(output: unknown, message: string) {
  const value = asRecord(output)
  return value ? { ...value, error: message } : { error: message }
}

function buildResidualUpdateError(rootDir: string, stashLabel: string, statusAfterStash: string) {
  const rootName = rootDir.split("/").filter(Boolean).at(-1) ?? "repo"
  const lines = [
    "Update failed: the working tree still has local changes after the automatic backup step.",
    `Saved backup stash: ${stashLabel}`,
    "",
    "Remaining paths:",
    statusAfterStash,
  ]

  if (statusAfterStash.includes(`?? ${rootName}/`)) {
    lines.push(
      "",
      `Detected a nested clone or duplicate project directory inside the repo: ${rootName}/`,
      `Move or remove ${rootName}/${rootName} if it exists, then run /update again.`,
    )
  }

  return lines.join("\n")
}

async function runGitCommand(rootDir: string, args: string[]) {
  const result = await execFileAsync("git", args, {
    cwd: rootDir,
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  return result.stdout.trim()
}

function acquireUpdateLock(rootDir: string) {
  const paths = getPaths(rootDir)
  mkdirSync(paths.runDir, { recursive: true })
  const lockPath = join(paths.runDir, "update.lock")
  try {
    const fd = openSync(lockPath, "wx")
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8")
    return {
      ok: true as const,
      release() {
        try {
          unlinkSync(lockPath)
        } catch {}
      },
    }
  } catch {
    return {
      ok: false as const,
      message: "Update already in progress in another Monolito process. Wait for it to finish and try /update again.",
    }
  }
}

function getTelegramChatId(sessionId: string) {
  return sessionId.startsWith("telegram-") ? sessionId.slice("telegram-".length) : null
}

function extractTelegramAudioFileId(text: string) {
  const voiceMatch = text.match(/<attachment kind="voice"[^>]*file_id="([^"]+)"/i)
  if (voiceMatch?.[1]) return voiceMatch[1]
  const audioMatch = text.match(/<attachment kind="audio"[^>]*file_id="([^"]+)"/i)
  if (audioMatch?.[1]) return audioMatch[1]
  return null
}

function hasTelegramTranscriptText(text: string) {
  return /<transcript\b[^>]*>[^<\s][\s\S]*?<\/transcript>/i.test(text)
}

function hasTelegramTranscriptUnavailable(text: string) {
  return /<transcript\b[^>]*status="unavailable"[^>]*\/>/i.test(text)
}

function injectTelegramTranscript(text: string, transcript: string, language?: string) {
  const payload = `<transcript source="stt" language="${(language ?? "").replaceAll("\"", "&quot;")}">${transcript
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")}</transcript>`
  return text.replace(/(<text>[\s\S]*?<\/text>)/i, `$1\n${payload}`).replace(/(<channel[^>]*>)/i, `$1\n${payload}`)
}

function sanitizeTranscribedTelegramReply(text: string) {
  const infraPattern = /\b(cuda|cpu fallback|driver|drivers|bash|shell|daemon|tooling|toolings?|pwd|timeout|stt|tts|whisper|faster[_-]?whisper|transcrib|docker)\b/i
  const blocks = text
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(Boolean)
    .filter(block => !infraPattern.test(block))

  if (blocks.length > 0) return blocks.join("\n\n").trim()

  const lines = text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !infraPattern.test(line))

  if (lines.length > 0) return lines.join("\n").trim()
  return "Recibi tu audio y voy a responder solo sobre su contenido."
}

function sanitizeExternalAssistantText(sessionId: string, text: string, lastUserText?: string) {
  if (!getTelegramChatId(sessionId)) return text
  const normalized = text.trim()

  if (/^Model request failed:/i.test(normalized) || /^Network\/model error after retries:/i.test(normalized)) {
    return "Tengo un problema tecnico temporal con el proveedor del modelo. Proba de nuevo en unos segundos."
  }

  if (/^Model request failed after retries$/i.test(normalized)) {
    return "No pude completar la respuesta por un problema temporal del modelo. Proba de nuevo en unos segundos."
  }

  if (lastUserText && hasTelegramTranscriptText(lastUserText)) {
    return sanitizeTranscribedTelegramReply(text)
  }

  return text
}

const TELEGRAM_MESSAGE_LIMIT = 4096

function chunkTelegramMessage(text: string, maxLength = TELEGRAM_MESSAGE_LIMIT) {
  const normalized = text.replace(/\r\n/g, "\n")
  if (normalized.length <= maxLength) return [normalized]

  const chunks: string[] = []
  let remaining = normalized
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength)
    const splitAt = Math.max(
      candidate.lastIndexOf("\n\n"),
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(" "),
    )
    const boundary = splitAt > maxLength * 0.5 ? splitAt : maxLength
    chunks.push(remaining.slice(0, boundary).trim())
    remaining = remaining.slice(boundary).trimStart()
  }
  if (remaining.trim()) chunks.push(remaining.trim())
  return chunks.filter(Boolean)
}

async function sendTelegramMessage(token: string, chatId: string, text: string) {
  for (const chunk of chunkTelegramMessage(text)) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    })
  }
}

async function sendTelegramTypingAction(token: string, chatId: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    })
  } catch {
    // Typing indicators are best-effort; message processing must not depend on them.
  }
}

function startTelegramTypingIndicator(sessionId: string): TelegramTypingIndicator | null {
  const chatId = getTelegramChatId(sessionId)
  if (!chatId) return null
  const config = readChannelsConfig()
  if (!config.telegram?.enabled || !config.telegram.token) return null
  const token = config.telegram.token

  void sendTelegramTypingAction(token, chatId)
  const interval = setInterval(() => {
    void sendTelegramTypingAction(token, chatId)
  }, TELEGRAM_TYPING_REFRESH_MS)
  interval.unref?.()
  return {
    stop() {
      clearInterval(interval)
    },
  }
}

export class MonolitoV2Runtime {
  readonly rootDir: string
  private listeners = new Set<EventListener>()
  private mcpClients = new Map<string, StdioMcpClient>()
  private activeSessions = new Set<string>()
  private recentResumeAt = new Map<string, number>()
  private abortControllers = new Map<string, AbortController>()
  private costState = createCostState()
  private adultModeSessions = new Set<string>()
  private restartRequested = false
  private toolStallState = new Map<string, { key: string; count: number }>()
  private stallAlerts = new Map<string, string>()
  readonly orchestrator: AgentOrchestrator

  private describeResumeReason(session: SessionRecord) {
    const lastEntry = session.worklog.at(-1)
    if (!lastEntry) return "session reopened"
    if (lastEntry.type === "note" && /Recovered after daemon (restart|shutdown)/.test(lastEntry.summary)) {
      return lastEntry.summary
    }
    if (lastEntry.type === "tool") {
      return `session reopened after tool activity: ${lastEntry.summary}`
    }
    if (lastEntry.type === "message") {
      return `session reopened after ${lastEntry.summary}`
    }
    return "session reopened"
  }

  constructor(rootDir: string) {
    this.rootDir = rootDir
    this.orchestrator = new AgentOrchestrator(this)
    getDb(this.rootDir)
    ensureConfigWings(this.rootDir)
    loadAndApplyModelSettings(process.env)
  }

  private recordToolFailureStall(sessionId: string, toolName: string, message: string) {
    const key = `${toolName}::${message}`
    const current = this.toolStallState.get(sessionId)
    const nextCount = current?.key === key ? current.count + 1 : 1
    this.toolStallState.set(sessionId, { key, count: nextCount })
    if (nextCount >= 2) {
      this.stallAlerts.set(sessionId, STALL_ALERT_MESSAGE)
    }
  }

  async handleBackgroundDelegationResult(task: DelegationTask, error?: string) {
    const sessionId = task.parentSessionId
    const session = getSession(this.rootDir, sessionId)
    if (!session) return
    const profileId = task.profileId || "default"
    const rawResult = task.result?.trim()
      ? task.result.trim()
      : error?.trim()
        ? `Error: ${error.trim()}`
        : `Background task ${task.status}`
    const systemPayload =
      `El worker de segundo plano acaba de retornar esta información cruda: [${rawResult}]. ` +
      "Asimilá estos datos como parte de tu propio procesamiento extendido y presentáselos al usuario de forma directa y natural. " +
      "No inicies la respuesta dando explicaciones técnicas sobre el sub-agente o la delegación, simplemente entregá el valor. " +
      "Si el usuario te pregunta sobre el proceso, podés confirmar que utilizaste un proceso de fondo."

    appendMessage(this.rootDir, sessionId, "system", systemPayload)
    appendWorklog(this.rootDir, sessionId, {
      type: "note",
      summary: `Background task ${task.status}: ${task.description}`,
    })

    void this.runProactiveBackgroundTurn(sessionId, profileId, systemPayload, 0)
  }

  private async runProactiveBackgroundTurn(sessionId: string, profileId: string, backgroundResult: string, attempt: number) {
    if (this.activeSessions.has(sessionId)) {
      if (attempt < 1) {
        setTimeout(() => {
          void this.runProactiveBackgroundTurn(sessionId, profileId, backgroundResult, attempt + 1)
        }, 2_000)
      }
      return
    }

    this.activeSessions.add(sessionId)
    const turnStartedAt = Date.now()
    try {
      loadAndApplyModelSettings(process.env)
      await this.transitionState(sessionId, "running")

      const session = getSession(this.rootDir, sessionId)
      if (!session) return

      const isMainSession = !session.id.startsWith("agent-") && !session.id.startsWith("telegram-")
      const [gitContext, dateContext, workspaceContext] = await Promise.all([
        getGitContext(this.rootDir),
        Promise.resolve(getDateContext()),
        Promise.resolve(getWorkspaceContext(this.rootDir, profileId, { isMainSession })),
      ])
      const webSearchConfig = readWebSearchConfig()

      const turn = await runAssistantTurn(
        session,
        this.rootDir,
        async (tool, input, context, toolUseId) => this.executeTool(sessionId, tool, input, { ...context, sessionId, orchestrator: this.orchestrator }, toolUseId, profileId),
        {
          rootDir: this.rootDir,
          cwd: this.rootDir,
          getMcpClient: async serverName => this.ensureMcpClient(serverName, sessionId),
          profileId,
          orchestrator: this.orchestrator,
        },
        {
          contextExtras: {
            gitContext,
            dateContext,
            workspaceContext,
            adultMode: this.adultModeSessions.has(sessionId),
            webSearchProvider: webSearchConfig.provider,
            backgroundResult,
          },
          costState: this.costState,
          turnStartedAt,
          maxTurnDurationMs: TURN_HARD_TIMEOUT_MS - 5_000,
        },
      )

      if (turn.usage) {
        recordApiCall(
          this.costState,
          getEffectiveModelConfig().model,
          {
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens,
          },
          Date.now() - turnStartedAt,
        )
      }

      const userFacingText = sanitizeExternalAssistantText(sessionId, turn.finalText)
      appendMessage(this.rootDir, sessionId, "assistant", userFacingText)
      appendWorklog(this.rootDir, sessionId, {
        type: "session",
        summary: turn.error ? `Background turn completed with model error: ${clipForWorklog(turn.error)}` : "Background turn completed",
      })
      this.emit({
        type: "turn.completed",
        sessionId,
        role: "assistant",
        durationMs: Date.now() - turnStartedAt,
        usage: turn.usage,
      })
      this.emit({ type: "message.received", sessionId, role: "assistant", text: userFacingText })

      const telegramChatId = getTelegramChatId(sessionId)
      if (telegramChatId && userFacingText) {
        try {
          const config = readChannelsConfig()
          if (config.telegram?.enabled && config.telegram.token) {
            await sendTelegramMessage(config.telegram.token, telegramChatId, userFacingText)
          }
        } catch (e) {
          console.error("Failed to send background reply to telegram", e)
        }
      }
    } finally {
      await this.transitionState(sessionId, "idle")
      this.activeSessions.delete(sessionId)
    }
  }

  private consumeStallAlert(sessionId: string) {
    const alert = this.stallAlerts.get(sessionId)
    if (alert) this.stallAlerts.delete(sessionId)
    return alert
  }

  onEvent(callback: EventListener) {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  ensureSession(sessionId?: string, title?: string, profileId = "default") {
    const existing = sessionId ? getSession(this.rootDir, sessionId) : null
    const session = ensureSession(this.rootDir, sessionId, title)
    ensureConfigWings(this.rootDir)
    ensureBootWings(this.rootDir, profileId)
    
    // Ensure the profile exists in DB
    const profiles = listProfiles(this.rootDir)
    if (!profiles.find(p => p.id === profileId)) {
      createProfile(this.rootDir, profileId, profileId, `Auto-generated profile for ${profileId}`)
    }

    if (existing) {
      if (existing.profileId !== profileId) {
        // Correct ownership if needed
        updateSessionProfile(this.rootDir, session.id, profileId)
        appendWorklog(this.rootDir, session.id, { 
          type: "note", 
          summary: `Session ownership transitioned from ${existing.profileId} to ${profileId}` 
        })
      }
      
      const lastResumeAt = this.recentResumeAt.get(session.id) ?? 0
      const lastEntry = existing.worklog.at(-1)
      const lastWasRecentResume =
        Date.now() - lastResumeAt < 5_000 ||
        lastEntry?.type === "session" &&
        lastEntry.summary.startsWith("Session resumed") &&
        Date.now() - Date.parse(lastEntry.at) < 5_000
      if (!lastWasRecentResume) {
        this.recentResumeAt.set(session.id, Date.now())
        appendWorklog(this.rootDir, session.id, {
          type: "session",
          summary: `Session resumed (${this.describeResumeReason(existing)})`,
        })
        this.emit({ type: "session.resumed", sessionId: session.id })
      }
    } else {
      this.emit({ type: "session.created", sessionId: session.id, title: session.title })
    }
    return session
  }

  listSessions() {
    return listSessions(this.rootDir)
  }

  getSession(sessionId: string) {
    return getSession(this.rootDir, sessionId)
  }

  private scheduleMemoryReview(
    sessionId: string,
    profileId: string,
    trigger: "post-turn" | "pre-compact" | "session-end",
    sessionSnapshot?: SessionRecord | null,
  ) {
    const snapshot = sessionSnapshot ?? getSession(this.rootDir, sessionId)
    if (!snapshot || snapshot.id.startsWith("agent-")) return
    void (async () => {
      try {
        await runMemoryAgentReview(this.rootDir, snapshot, profileId, trigger)
      } catch (error) {
        console.error(`Memory agent failed (${trigger}) for ${sessionId}:`, error)
      }
    })()
  }

  tailEvents(sessionId: string, lines?: number) {
    return tailEvents(this.rootDir, sessionId, lines)
  }

  async processMessage(sessionId: string, text: string) {
    if (this.activeSessions.has(sessionId)) {
      throw createSessionBusyError(sessionId)
    }
    this.activeSessions.add(sessionId)
    try {
      loadAndApplyModelSettings(process.env)

      const session = this.getSession(sessionId)
      const profileId = (session as SessionRecord & { profileId?: string } | null)?.profileId ?? "default"

      appendMessage(this.rootDir, sessionId, "user", text)
      appendWorklog(this.rootDir, sessionId, {
        type: "session",
        summary: `Turn started (${text.trim().startsWith("/") ? "slash-command" : "user-message"})`,
      })
      this.emit({ type: "message.received", sessionId, role: "user", text })
      await this.transitionState(sessionId, "running")

      await this.runTurn(sessionId, text, profileId)
    } catch (error) {
      this.activeSessions.delete(sessionId)
      throw error
    }
  }

  async processSessionStartup(sessionId: string, prompt: string, options?: { logger?: Logger }) {
    const session = getSession(this.rootDir, sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    if (this.activeSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} ya está ocupada`)
    }

    const profileId = (session as SessionRecord & { profileId?: string } | null)?.profileId ?? "default"
    const turnStartedAt = new Date().toISOString()
    this.activeSessions.add(sessionId)
    try {
      appendWorklog(this.rootDir, sessionId, {
        type: "session",
        summary: "Turn started (session-startup)",
      })
      await this.transitionState(sessionId, "running")
      await this.runStartupTurn(sessionId, prompt, profileId, turnStartedAt, { logger: options?.logger })
    } finally {
      this.activeSessions.delete(sessionId)
    }
  }

  async runTurn(sessionId: string, lastUserText: string, profileId = "default", options?: { logger?: Logger }) {
    const turnStartedAt = Date.now()
    const instanceLogger = options?.logger
    const abortController = new AbortController()
    const telegramTyping = startTelegramTypingIndicator(sessionId)
    this.abortControllers.set(sessionId, abortController)
    const turnTimeout = setTimeout(() => {
      appendWorklog(this.rootDir, sessionId, {
        type: "note",
        summary: `Hard turn timeout reached after ${TURN_HARD_TIMEOUT_MS}ms; aborting active work`,
      })
      abortController.abort(new TurnTimeoutError(`Turn exceeded hard timeout of ${TURN_HARD_TIMEOUT_MS}ms`))
    }, TURN_HARD_TIMEOUT_MS)
    
    try {
      if (lastUserText.startsWith("/")) {
        const reply = await this.runSlashCommand(sessionId, lastUserText)
        if (reply === "__SESSION_RESET__") {
          // Session was reset — run startup turn with fresh context
          const resetSession = getSession(this.rootDir, sessionId)
          const resetProfileId = (resetSession as SessionRecord & { profileId?: string } | null)?.profileId ?? "default"
          const resetWorkspaceContext = getWorkspaceContext(this.rootDir, resetProfileId, { isMainSession: true })
          const startupPrompt = resetWorkspaceContext.bootstrapPending
            ? "El bootstrap del workspace sigue pendiente. Inicia ahora el ritual de primer arranque usando el contexto inyectado de BOOT_BOOTSTRAP, BOOT_IDENTITY, BOOT_USER, BOOT_SOUL y BOOT_AGENTS. Deja que el modelo orqueste la conversacion segun lo ya sabido. Responde en el idioma del usuario; si aun no hay una preferencia clara, comienza en espanol neutro y adapta el idioma enseguida si el usuario marca otro. Saluda brevemente y haz exactamente una sola pregunta corta por turno. No recites una checklist ni menciones almacenamiento interno salvo que el usuario lo pida."
            : "A new session was started via /new. Run your Session Startup sequence using the injected BOOT context already present in this turn before responding. Then greet the user in your configured persona. Keep it to 1-3 sentences. Do not mention internal steps, tools, or reasoning."
          this.activeSessions.delete(sessionId)
          await this.processSessionStartup(sessionId, startupPrompt, { logger: instanceLogger })
          return { finalText: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
        }
        appendMessage(this.rootDir, sessionId, "assistant", reply)
        appendWorklog(this.rootDir, sessionId, {
          type: "session",
          summary: "Turn completed (slash-command)",
        })
        this.emit({ type: "message.received", sessionId, role: "assistant", text: reply })
        this.emit({
          type: "turn.completed",
          sessionId,
          role: "assistant",
          durationMs: Date.now() - turnStartedAt,
        })
        const telegramChatId = getTelegramChatId(sessionId)
        if (telegramChatId && reply) {
          try {
            const config = readChannelsConfig()
            if (config.telegram?.enabled && config.telegram.token) {
              await sendTelegramMessage(config.telegram.token, telegramChatId, reply)
            }
          } catch {}
        }
        await this.transitionState(sessionId, "idle")
        this.scheduleMemoryReview(sessionId, profileId, "post-turn")
        return { finalText: reply, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
      } else {
        const session = getSession(this.rootDir, sessionId)
        if (!session) throw new Error(`Session ${sessionId} not found`)
        let preparedUserText = lastUserText
        const incomingTelegramChatId = getTelegramChatId(sessionId)
        if (incomingTelegramChatId && !hasTelegramTranscriptText(preparedUserText) && !hasTelegramTranscriptUnavailable(preparedUserText)) {
          const fileId = extractTelegramAudioFileId(preparedUserText)
          if (fileId) {
            try {
              const toolContext = {
                rootDir: this.rootDir,
                cwd: this.rootDir,
                getMcpClient: async (serverName: string) => this.ensureMcpClient(serverName, sessionId),
                profileId,
                sessionId,
                orchestrator: this.orchestrator,
                logger: instanceLogger,
              }
              const downloaded = await this.executeTool(sessionId, "TelegramDownloadFile", { file_id: fileId }, toolContext, undefined, profileId) as { local_path?: string }
              if (downloaded.local_path) {
                const transcribed = await this.executeTool(sessionId, "TranscribeAudio", { path: downloaded.local_path }, toolContext, undefined, profileId) as { text?: string; language?: string }
                if (typeof transcribed.text === "string" && transcribed.text.trim()) {
                  preparedUserText = injectTelegramTranscript(preparedUserText, transcribed.text.trim(), transcribed.language)
                }
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              appendWorklog(this.rootDir, sessionId, {
                type: "note",
                summary: `Automatic Telegram audio transcription failed before model turn: ${message}`,
              })
            }
          }
        }
        const preparedSession =
          preparedUserText !== lastUserText && session.messages.length > 0
            ? {
                ...session,
                messages: [
                  ...session.messages.slice(0, -1),
                  { ...session.messages[session.messages.length - 1], text: preparedUserText },
                ],
              }
            : session
        const apiStartedAt = Date.now()
        const isMainSession = !session.id.startsWith("agent-") && !session.id.startsWith("telegram-")
        const [gitContext, dateContext, workspaceContext] = await Promise.all([
          getGitContext(this.rootDir),
          Promise.resolve(getDateContext()),
          Promise.resolve(getWorkspaceContext(this.rootDir, profileId, { isMainSession })),
        ])
        const webSearchConfig = readWebSearchConfig()
        const turn = await runAssistantTurn(
          preparedSession,
          this.rootDir,
          async (tool, input, context, toolUseId) => this.executeTool(sessionId, tool, input, { ...context, sessionId, orchestrator: this.orchestrator }, toolUseId, profileId),
          {
            rootDir: this.rootDir,
            cwd: this.rootDir,
            getMcpClient: async serverName => this.ensureMcpClient(serverName, sessionId),
            profileId,
            orchestrator: this.orchestrator,
            logger: instanceLogger,
          },
          {
            contextExtras: {
              gitContext,
              dateContext,
              workspaceContext,
              adultMode: this.adultModeSessions.has(sessionId),
              webSearchProvider: webSearchConfig.provider,
              stallAlert: this.consumeStallAlert(sessionId),
            },
            costState: this.costState,
            abortSignal: abortController.signal,
            turnStartedAt,
            maxTurnDurationMs: TURN_HARD_TIMEOUT_MS - 5_000,
          },
        )
        if (turn.usage) {
          recordApiCall(
            this.costState,
            getEffectiveModelConfig().model,
            {
              inputTokens: turn.usage.inputTokens,
              outputTokens: turn.usage.outputTokens,
            },
            Date.now() - apiStartedAt,
          )
        }
        const userFacingText = sanitizeExternalAssistantText(sessionId, turn.finalText, preparedUserText)
        appendMessage(this.rootDir, sessionId, "assistant", userFacingText)
        appendWorklog(this.rootDir, sessionId, {
          type: "session",
          summary: turn.error ? `Turn completed with model error: ${clipForWorklog(turn.error)}` : "Turn completed",
        })
        this.emit({ type: "message.received", sessionId, role: "assistant", text: userFacingText })
        this.emit({
          type: "turn.completed",
          sessionId,
          role: "assistant",
          durationMs: Date.now() - turnStartedAt,
          usage: turn.usage,
        })
        
        const telegramChatId = getTelegramChatId(sessionId)
        if (telegramChatId && userFacingText) {
          try {
            const config = readChannelsConfig()
            if (config.telegram?.enabled && config.telegram.token) {
              await sendTelegramMessage(config.telegram.token, telegramChatId, userFacingText)
            }
          } catch (e) {
            console.error("Failed to send reply back to telegram", e)
          }
        }
        await this.transitionState(sessionId, turn.error ? "error" : "idle")
        this.scheduleMemoryReview(sessionId, profileId, "post-turn")
        return turn
      }
    } catch (error) {
      const timeoutReason = abortController.signal.reason
      if (timeoutReason instanceof TurnTimeoutError) {
        const message = `No pude terminar este turno dentro del límite duro de ${Math.floor(TURN_HARD_TIMEOUT_MS / 1000)}s. Reintentá con un pedido más acotado o dividilo en pasos.`
        appendWorklog(this.rootDir, sessionId, {
          type: "session",
          summary: `Turn failed: ${clipForWorklog(message)}`,
        })
        this.emit({ type: "error", sessionId, error: message })
        appendMessage(this.rootDir, sessionId, "assistant", message)
        this.emit({ type: "message.received", sessionId, role: "assistant", text: message })
        await this.transitionState(sessionId, "error")
        return {
          finalText: message,
          steps: [{ type: "final", message }],
          error: message,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          meta: {
            iterationCount: 0,
            durationMs: Date.now() - turnStartedAt,
            stopReason: "max_duration",
          },
        }
      }
      if (error instanceof Error && error.name === "AbortError") {
        appendWorklog(this.rootDir, sessionId, {
          type: "session",
          summary: "Turn aborted by operator",
        })
        this.emit({ type: "error", sessionId, error: "Stopped" })
        await this.transitionState(sessionId, "idle")
        throw error
      }
      const message = sanitizeExternalAssistantText(sessionId, error instanceof Error ? error.message : String(error))
      appendWorklog(this.rootDir, sessionId, {
        type: "session",
        summary: `Turn failed: ${clipForWorklog(message)}`,
      })
      this.emit({ type: "error", sessionId, error: message })
      appendMessage(this.rootDir, sessionId, "assistant", message)
      this.emit({ type: "message.received", sessionId, role: "assistant", text: message })
      await this.transitionState(sessionId, "error")
      return {
        finalText: message,
        steps: [{ type: "final", message }],
        error: message,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }
    } finally {
      clearTimeout(turnTimeout)
      telegramTyping?.stop()
      this.activeSessions.delete(sessionId)
      this.abortControllers.delete(sessionId)
    }
  }

  private async runStartupTurn(sessionId: string, prompt: string, profileId = "default", turnStartedAtIso?: string, options?: { logger?: Logger }) {
    const turnStartedAt = turnStartedAtIso ? Date.parse(turnStartedAtIso) : Date.now()
    const abortController = new AbortController()
    this.abortControllers.set(sessionId, abortController)
    const turnTimeout = setTimeout(() => {
      appendWorklog(this.rootDir, sessionId, {
        type: "note",
        summary: `Hard turn timeout reached after ${TURN_HARD_TIMEOUT_MS}ms; aborting active work`,
      })
      abortController.abort(new TurnTimeoutError(`Turn exceeded hard timeout of ${TURN_HARD_TIMEOUT_MS}ms`))
    }, TURN_HARD_TIMEOUT_MS)

    try {
      const session = getSession(this.rootDir, sessionId)
      if (!session) throw new Error(`Session ${sessionId} not found`)
      const syntheticSession: SessionRecord = {
        ...session,
        messages: [
          ...session.messages,
          { at: new Date().toISOString(), role: "user", text: prompt },
        ],
      }
      const isMainSession = !session.id.startsWith("agent-") && !session.id.startsWith("telegram-")
      const [gitContext, dateContext, workspaceContext] = await Promise.all([
        getGitContext(this.rootDir),
        Promise.resolve(getDateContext()),
        Promise.resolve(getWorkspaceContext(this.rootDir, profileId, { isMainSession })),
      ])
      const webSearchConfig = readWebSearchConfig()
      const apiStartedAt = Date.now()
      const turn = await runAssistantTurn(
        syntheticSession,
        this.rootDir,
        async (tool, input, context, toolUseId) => this.executeTool(sessionId, tool, input, { ...context, sessionId, orchestrator: this.orchestrator }, toolUseId, profileId),
        {
          rootDir: this.rootDir,
          cwd: this.rootDir,
          getMcpClient: async serverName => this.ensureMcpClient(serverName, sessionId),
          profileId,
          orchestrator: this.orchestrator,
          logger: options?.logger,
        },
        {
          contextExtras: {
            gitContext,
            dateContext,
            workspaceContext,
            adultMode: this.adultModeSessions.has(sessionId),
            webSearchProvider: webSearchConfig.provider,
            stallAlert: this.consumeStallAlert(sessionId),
          },
          costState: this.costState,
          abortSignal: abortController.signal,
          turnStartedAt,
          maxTurnDurationMs: TURN_HARD_TIMEOUT_MS - 5_000,
        },
      )
      if (turn.usage) {
        recordApiCall(
          this.costState,
          getEffectiveModelConfig().model,
          {
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens,
          },
          Date.now() - apiStartedAt,
        )
      }
      const userFacingText = sanitizeExternalAssistantText(sessionId, turn.finalText, prompt)
      appendMessage(this.rootDir, sessionId, "assistant", userFacingText)
      appendWorklog(this.rootDir, sessionId, {
        type: "session",
        summary: turn.error ? `Turn completed with model error: ${clipForWorklog(turn.error)}` : "Turn completed",
      })
      this.emit({ type: "message.received", sessionId, role: "assistant", text: userFacingText })
      this.emit({
        type: "turn.completed",
        sessionId,
        role: "assistant",
        durationMs: Date.now() - turnStartedAt,
        usage: turn.usage,
      })
      await this.transitionState(sessionId, turn.error ? "error" : "idle")
      return turn
    } catch (error) {
      const timeoutReason = abortController.signal.reason
      const message = timeoutReason instanceof TurnTimeoutError
        ? `No pude terminar este arranque dentro del límite duro de ${Math.floor(TURN_HARD_TIMEOUT_MS / 1000)}s.`
        : error instanceof Error ? error.message : String(error)
      appendWorklog(this.rootDir, sessionId, {
        type: "session",
        summary: `Turn failed: ${clipForWorklog(message)}`,
      })
      this.emit({ type: "error", sessionId, error: message })
      appendMessage(this.rootDir, sessionId, "assistant", message)
      this.emit({ type: "message.received", sessionId, role: "assistant", text: message })
      await this.transitionState(sessionId, "error")
      throw error
    } finally {
      clearTimeout(turnTimeout)
      this.abortControllers.delete(sessionId)
    }
  }

  abortSession(sessionId: string) {
    const controller = this.abortControllers.get(sessionId)
    if (controller) {
      controller.abort()
    }
  }

  consumeRestartRequest() {
    const requested = this.restartRequested
    this.restartRequested = false
    return requested
  }

  private async transitionState(sessionId: string, state: "idle" | "running" | "error") {
    setSessionState(this.rootDir, sessionId, state)
    this.emit({ type: "state.changed", sessionId, state })
  }

  emit(event: AgentEvent) {
    appendEvent(this.rootDir, event)
    void this.mirrorTelegramEvent(event)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error("Runtime event listener error:", err)
      }
    }
  }

  private async mirrorTelegramEvent(event: AgentEvent) {
    const chatId = getTelegramChatId(event.sessionId)
    if (!chatId) return
    void chatId
  }

  private async ensureMcpClient(serverName: string, sessionId: string) {
    const server = getDefaultMcpServers(this.rootDir)[serverName as "demo"]
    if (!server) throw new Error(`Unknown MCP server: ${serverName}`)
    let client = this.mcpClients.get(serverName)
    if (!client) {
      client = new StdioMcpClient(server.command, server.cwd)
      await client.initialize()
      this.mcpClients.set(serverName, client)
      this.emit({ type: "mcp.connected", sessionId, server: serverName })
    }
    return client
  }

  private async runSlashCommand(sessionId: string, line: string) {
    const [command, ...rest] = line.trim().split(" ")
    switch (command) {
      case "/help":
        return [
          "Commands:",
          "/help",
          "/status",
          "/sessions",
          "/tool <name> <json>",
          "/mcp tools <server>",
          "/mcp resources <server>",
          "/mcp read <server> <uri>",
          "/mcp call <server> <tool> <json>",
          "/model",
          "/model info",
          "/model set <base_url|api_key|model> <value>",
          "/model reset",
          "/history [limit]",
          "/cost",
          "/compact [max-messages]",
          "/stats",
          "/doctor",
          "/update",
          "/channels [show|on|off|token <token>|chats <id,id,...>|clear]",
          "/config [show|set <base_url|api_key|model|tts_base_url|tts_api_key|tts_voice|tts_model|tts_format|tts_speed|tts_managed|tts_auto_deploy|tts_port> <value>]",
          "/tts [show|on|off|deploy|stop|remove|list|status]",
          "/stt [show|on|off|deploy|stop|remove|list|status]",
          "/adult — Toggle adult content mode",
          "/websearch — Open web search menu",
          "/dashboard — Open Master Configuration Hub",
          "/new — Reset session and restart agent",
        ].join("\n")
      case "/status": {
        return JSON.stringify(
          {
            session: getSession(this.rootDir, sessionId),
            model: redactSensitiveModelSettings(readModelSettings()),
            tools: listTools().map(tool => tool.name),
          },
          null,
          2,
        )
      }
      case "/sessions":
        return listSessions(this.rootDir).map(item => `${item.id} ${item.state} ${item.title}`).join("\n")
      case "/tool":
        return this.runToolCommand(sessionId, rest)
      case "/mcp":
        return this.runMcpCommand(sessionId, rest)
      case "/model":
        return this.runModelCommand(rest)
      case "/history":
        return this.runHistoryCommand(sessionId, rest)
      case "/cost":
        return formatCostSummary(this.costState)
      case "/compact": {
        const session = getSession(this.rootDir, sessionId)
        const profileId = (session as SessionRecord & { profileId?: string } | null)?.profileId ?? "default"
        this.scheduleMemoryReview(sessionId, profileId, "pre-compact", session)
        const max = rest[0] ? Number.parseInt(rest[0], 10) : undefined
        const result = compactSession(this.rootDir, sessionId, max ? { maxMessages: max } : {})
        return `Compacted ${result.compacted} message${result.compacted !== 1 ? "s" : ""}. ${result.remaining} remaining.`
      }
      case "/stats": {
        const stats = getSessionStats(this.rootDir, sessionId)
        if (!stats) return "Session not found."
        return [
          `Messages: ${stats.messageCount}`,
          `Characters: ${stats.totalChars.toLocaleString()}`,
          `Worklog entries: ${stats.worklogEntries}`,
          `Created: ${stats.createdAt}`,
          `Updated: ${stats.updatedAt}`,
          `State: ${stats.state}`,
        ].join("\n")
      }
      case "/doctor": {
        return this.runDoctor()
      }
      case "/update": {
        return this.runUpdate()
      }
      case "/channels": {
        return this.runChannelsCommand(rest)
      }
      case "/tts": {
        return this.runTtsCommand(rest)
      }
      case "/stt": {
        return this.runSttCommand(rest)
      }
      case "/websearch": {
        return this.runWebSearchCommand(rest)
      }
      case "/config": {
        return this.runConfig(rest)
      }
      case "/adult": {
        const isActive = this.adultModeSessions.has(sessionId)
        if (isActive) {
          this.adultModeSessions.delete(sessionId)
          return "Modo adulto desactivado."
        }
        this.adultModeSessions.add(sessionId)
        return "Modo adulto activado."
      }
      case "/new":
      case "/reset": {
        const session = getSession(this.rootDir, sessionId)
        const profileId = (session as SessionRecord & { profileId?: string } | null)?.profileId ?? "default"
        this.scheduleMemoryReview(sessionId, profileId, "session-end", session)
        resetSession(this.rootDir, sessionId)
        return "__SESSION_RESET__"
      }
      default:
        return `Unknown slash command: ${command}`
    }
  }

  private async runToolCommand(sessionId: string, rest: string[]) {
    const name = rest[0]
    if (!name) {
      return listTools().map(tool => `${tool.name} - ${tool.description}`).join("\n")
    }
    const tool = getTool(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    const session = getSession(this.rootDir, sessionId)
    const raw = rest.slice(1).join(" ").trim()
    const input = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    const output = await this.executeTool(sessionId, tool.name, input, {
      rootDir: this.rootDir,
      cwd: this.rootDir,
      getMcpClient: async serverName => this.ensureMcpClient(serverName, sessionId),
      profileId: session?.profileId,
      sessionId,
      orchestrator: this.orchestrator,
    })
    return JSON.stringify(output, null, 2)
  }

  private async executeTool(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
    toolUseId?: string,
    profileId?: string,
  ) {
    const tool = getTool(toolName)
    if (!tool) throw new Error(`Unknown tool: ${toolName}`)
    const normalizedInput = normalizeToolInputPayload(input) as Record<string, unknown>
    const permission = await checkToolPermission(tool.name, normalizedInput, {
      rootDir: this.rootDir,
      sessionId,
      profileId: profileId ?? context.profileId,
    })
    if (permission.behavior !== "allow") {
      const message = permission.message ?? `Permission denied for tool ${tool.name}.`
      appendWorklog(this.rootDir, sessionId, {
        type: "tool",
        summary: `Tool ${tool.name} blocked: ${message}`,
      })
      this.emit({ type: "error", sessionId, error: message })
      this.recordToolFailureStall(sessionId, tool.name, message)
      throw new Error(message)
    }
    this.emit({ type: "tool.start", sessionId, toolUseId, tool: tool.name, input: normalizedInput })
    const toolStartedAt = Date.now()

    const tryRepairBashFailure = async (error: ToolExecutionError) => {
      if (tool.name !== "Bash") throw error
      if (!error.command || error.exitCode === 0) throw error

      let currentError = error
      let repairedCommand = error.command
      const bashTool = tool
      const attemptedCommands = new Set<string>([error.command])

      for (let attempt = 1; attempt <= COMMAND_REPAIR_MAX_ATTEMPTS; attempt++) {
        appendWorklog(this.rootDir, sessionId, {
          type: "tool",
          summary: `CommandRepairLoop attempt ${attempt}/${COMMAND_REPAIR_MAX_ATTEMPTS} for Bash`,
        })

        const repair = await runBackgroundTextTask(
          this.rootDir,
          buildCommandRepairSystemPrompt(
            repairedCommand,
            currentError.exitCode,
            currentError.stderr,
          ),
          `Return only the corrected command for: ${repairedCommand}`,
          { logger: context.logger },
        )

        const candidate = extractRepairedCommand(repair.text)
        if (!candidate) break
        if (attemptedCommands.has(candidate)) break
        attemptedCommands.add(candidate)
        repairedCommand = candidate

        const repairedInput = { ...normalizedInput, command: candidate }
        const repairedPermission = await checkToolPermission(tool.name, repairedInput, {
          rootDir: this.rootDir,
          sessionId,
          profileId: profileId ?? context.profileId,
        })
        if (repairedPermission.behavior !== "allow") {
          appendWorklog(this.rootDir, sessionId, {
            type: "tool",
            summary: `CommandRepairLoop blocked repaired Bash command: ${repairedPermission.message ?? "Permission denied."}`,
          })
          break
        }

        const repairedOutput = await bashTool.run(
          repairedInput,
          { ...context, profileId: profileId ?? context.profileId },
        )

        await runPostToolHooks(tool.name, repairedInput, {
          rootDir: this.rootDir,
          sessionId,
          profileId: profileId ?? context.profileId,
        }, repairedOutput)

        const repairedError = buildToolExecutionError(tool.name, repairedOutput)
        if (!repairedError) {
          appendWorklog(this.rootDir, sessionId, {
            type: "tool",
            summary: `CommandRepairLoop fixed Bash on attempt ${attempt}`,
          })
          return repairedOutput
        }

        currentError = repairedError
      }

      throw currentError
    }

    try {
      let output = await tool.run(normalizedInput, { ...context, profileId: profileId ?? context.profileId })
      await runPostToolHooks(tool.name, normalizedInput, {
        rootDir: this.rootDir,
        sessionId,
        profileId: profileId ?? context.profileId,
      }, output)
      const executionError = buildToolExecutionError(tool.name, output)
      if (executionError) {
        output = await tryRepairBashFailure(executionError)
      }
      recordToolCall(this.costState, Date.now() - toolStartedAt)
      appendWorklog(this.rootDir, sessionId, {
        type: "tool",
        summary: `Tool ${tool.name} finished successfully`,
      })
      appendActionLog(this.rootDir, "Herramienta ejecutada", {
        tool: tool.name,
        sessionId,
      })
      this.emit({ type: "tool.finish", sessionId, toolUseId, tool: tool.name, ok: true, output })
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const output = error instanceof ToolExecutionError ? error.output : undefined
      this.recordToolFailureStall(sessionId, tool.name, message)
      recordToolCall(this.costState, Date.now() - toolStartedAt)
      appendWorklog(this.rootDir, sessionId, {
        type: "tool",
        summary: `Tool ${tool.name} failed: ${message}`,
      })
      this.emit({ type: "tool.finish", sessionId, toolUseId, tool: tool.name, ok: false, output: outputWithError(output, message) })
      throw error
    }
  }

  recoverSessions(summary?: string) {
    return recoverRunningSessions(this.rootDir, summary)
  }

  close() {
    for (const client of this.mcpClients.values()) {
      client.close()
    }
    this.mcpClients.clear()
    this.recoverSessions("Recovered after daemon shutdown")
  }

  private async runMcpCommand(sessionId: string, rest: string[]) {
    const action = rest[0]
    const serverName = rest[1] ?? "demo"
    const client = await this.ensureMcpClient(serverName, sessionId)
    if (action === "tools") {
      return JSON.stringify(await client.listTools(), null, 2)
    }
    if (action === "resources") {
      return JSON.stringify(await client.listResources(), null, 2)
    }
    if (action === "read") {
      return JSON.stringify(await client.readResource(rest[2] ?? "monolito://demo/status"), null, 2)
    }
    if (action === "call") {
      const tool = rest[2]
      if (!tool) throw new Error("Usage: /mcp call <server> <tool> <json>")
      const rawArgs = rest.slice(3).join(" ").trim()
      const args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {}
      this.emit({ type: "mcp.called", sessionId, server: serverName, tool })
      return JSON.stringify(await client.callTool(tool, args), null, 2)
    }
    return "Usage: /mcp tools <server> | /mcp resources <server> | /mcp read <server> <uri> | /mcp call <server> <tool> <json>"
  }

  private async runModelCommand(rest: string[]) {
    const action = (rest[0] ?? "").trim()
    if (!action || action === "info" || action === "show" || action === "status") {
      const storedSettings = readModelSettings()
      const effective = getEffectiveModelConfig()
      return [
        `Protocol: ${storedSettings.modelConfig.protocol}`,
        `Base URL: ${effective.baseUrl || "(system/default)"}`,
        `API key: ${maskApiKey(effective.apiKey)}`,
        `Model: ${effective.model || "(unset)"}`,
        "",
        "Persisted settings:",
        JSON.stringify(redactSensitiveModelSettings(storedSettings), null, 2),
      ].join("\n")
    }
    if (action === "reset") {
      const settings = draftToSettings(
        {
          protocol: MODEL_PROTOCOL,
          baseUrl: "",
          apiKey: "",
          model: "",
        },
        { env: process.env },
      )
      saveModelSettings(settings)
      applyModelSettingsToEnv(process.env, settings)
      return "Model settings reset to defaults and applied."
    }

    const nextDraft = settingsToDraft(readModelSettings({ env: process.env }))
    if (action === "set") {
      const field = (rest[1] ?? "").trim()
      const value = rest.slice(2).join(" ").trim()
      if (!field || !value) throw new Error("Usage: /model set <base_url|api_key|model> <value>")
      if (field === "base_url") nextDraft.baseUrl = value
      else if (field === "api_key") nextDraft.apiKey = value
      else if (field === "model") nextDraft.model = value
      else throw new Error("Usage: /model set <base_url|api_key|model> <value>")
    } else {
      nextDraft.model = rest.join(" ").trim()
    }

    nextDraft.protocol = MODEL_PROTOCOL
    const errors = validateModelDraft(nextDraft, process.env)
    if (errors.length > 0) throw new Error(errors[0] ?? "Invalid model configuration")

    const settings = draftToSettings(nextDraft, { env: process.env })
    saveModelSettings(settings)
    applyModelSettingsToEnv(process.env, settings)
    const effective = getEffectiveModelConfig()
    return [
      "Saved model settings.",
      `Protocol: ${settings.modelConfig.protocol}`,
      `Base URL: ${effective.baseUrl || "(system/default)"}`,
      `API key: ${maskApiKey(effective.apiKey)}`,
      `Model: ${effective.model || "(unset)"}`,
    ].join("\n")
  }

  private async runHistoryCommand(sessionId: string, rest: string[]) {
    const limitRaw = rest[0]
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20
    if (!Number.isFinite(limit) || limit < 1) throw new Error("Usage: /history [limit]")
    const session = getSession(this.rootDir, sessionId)
    if (!session || session.worklog.length === 0) return "No history entries for this session yet."
    return session.worklog.slice(-limit).map(entry => `${entry.at} [${entry.type}] ${entry.summary}`).join("\n")
  }

  private async runChannelsCommand(rest: string[]) {
    const action = (rest[0] ?? "show").trim().toLowerCase()
    const config = readChannelsConfig()
    const telegram = config.telegram ?? { token: "", enabled: false, allowedChats: [] }

    if (action === "show" || action === "status" || !action) {
      return [
        "Telegram channel configuration:",
        `Enabled: ${telegram.enabled ? "yes" : "no"}`,
        `Token: ${telegram.token ? "configured" : "missing"}`,
        `Allowed chats: ${telegram.allowedChats.length > 0 ? telegram.allowedChats.join(", ") : "(all chats allowed)"}`,
        "",
        "Usage:",
        "/channels on",
        "/channels off",
        "/channels token <token>",
        "/channels chats <id,id,...>",
        "/channels clear",
      ].join("\n")
    }

    if (action === "on" || action === "enable") {
      config.telegram = { ...telegram, enabled: true }
      writeChannelsConfig(config)
      this.restartRequested = true
      return "Telegram habilitado. Reinicio del daemon programado automáticamente."
    }

    if (action === "off" || action === "disable") {
      config.telegram = { ...telegram, enabled: false }
      writeChannelsConfig(config)
      this.restartRequested = true
      return "Telegram deshabilitado. Reinicio del daemon programado automáticamente."
    }

    if (action === "token") {
      const token = rest.slice(1).join(" ").trim()
      if (!token) return "Usage: /channels token <token>"
      config.telegram = { ...telegram, token, enabled: true }
      writeChannelsConfig(config)
      this.restartRequested = true
      return "Token de Telegram guardado. Reinicio del daemon programado automáticamente."
    }

    if (action === "chats") {
      const raw = rest.slice(1).join(" ").trim()
      if (!raw) return "Usage: /channels chats <id,id,...>"
      const { ids, invalid } = parseAllowedChats(raw)
      if (invalid.length > 0) return `IDs inválidos: ${invalid.join(", ")}`
      config.telegram = { ...telegram, allowedChats: ids }
      writeChannelsConfig(config)
      this.restartRequested = true
      return `Chats autorizados guardados: ${ids.join(", ")}. Reinicio del daemon programado automáticamente.`
    }

    if (action === "clear") {
      config.telegram = { ...telegram, allowedChats: [] }
      writeChannelsConfig(config)
      this.restartRequested = true
      return "Lista de chats autorizados limpiada. Reinicio del daemon programado automáticamente."
    }

    return "Usage: /channels [show|on|off|token <token>|chats <id,id,...>|clear]"
  }

  private async runTtsCommand(rest: string[]) {
    const config = readChannelsConfig()
    const action = (rest[0] ?? "show").trim().toLowerCase()
    const tts = normalizeTtsConfig(config.tts)

    if (action === "show" || action === "status" || !action) {
      const status = await getManagedTtsStatus(tts)
      return [
        `TTS managed: ${tts.managed ? "yes" : "no"}`,
        `TTS auto deploy: ${tts.autoDeploy ? "yes" : "no"}`,
        `TTS status: ${status}`,
        `TTS URL: ${tts.managed ? getManagedTtsBaseUrl(tts) : (tts.baseUrl || "(not configured)")}`,
        `TTS voice: ${tts.voice}`,
        `TTS format: ${tts.responseFormat}`,
      ].join("\n")
    }

    if (action === "on" || action === "enable") {
      config.tts = { ...(config.tts ?? {}), managed: true, autoDeploy: true }
      writeChannelsConfig(config)
      const next = normalizeTtsConfig(config.tts)
      return `TTS administrado habilitado. URL administrada: ${getManagedTtsBaseUrl(next)}`
    }

    if (action === "off" || action === "disable") {
      config.tts = { ...(config.tts ?? {}), managed: false }
      writeChannelsConfig(config)
      return "TTS administrado deshabilitado."
    }

    if (action === "deploy" || action === "start") {
      config.tts = { ...(config.tts ?? {}), managed: true }
      writeChannelsConfig(config)
      const next = normalizeTtsConfig(config.tts)
      const result = await deployManagedTtsContainer(next)
      return result.ok ? result.message : `Error: ${result.message}`
    }

    if (action === "stop") {
      const result = await stopManagedTtsContainer(tts)
      return result.ok ? result.message : `Error: ${result.message}`
    }

    if (action === "remove" || action === "rm") {
      const result = await removeManagedTtsContainer(tts)
      return result.ok ? result.message : `Error: ${result.message}`
    }

    if (action === "list" || action === "ls") {
      return await listManagedTtsContainers(tts)
    }

    return "Usage: /tts [show|on|off|deploy|stop|remove|list|status]"
  }

  private async runSttCommand(rest: string[]) {
    const config = readChannelsConfig()
    const action = (rest[0] ?? "show").trim().toLowerCase()
    const stt = normalizeSttConfig(config.stt)

    if (action === "show" || action === "status" || !action) {
      const status = await getManagedSttStatus(stt)
      return [
        `STT managed: ${stt.managed ? "yes" : "no"}`,
        `STT auto deploy: ${stt.autoDeploy ? "yes" : "no"}`,
        `STT auto transcribe: ${stt.autoTranscribe ? "yes" : "no"}`,
        `STT status: ${status}`,
        `STT URL: ${getManagedSttBaseUrl(stt)}`,
        `STT engine: ${stt.engine}`,
        `STT model: ${stt.model}`,
        `STT language: ${stt.language}`,
      ].join("\n")
    }

    if (action === "on" || action === "enable") {
      config.stt = { ...(config.stt ?? {}), managed: true, autoDeploy: true, autoTranscribe: true }
      writeChannelsConfig(config)
      const next = normalizeSttConfig(config.stt)
      return `STT administrado habilitado. URL administrada: ${getManagedSttBaseUrl(next)}`
    }

    if (action === "off" || action === "disable") {
      config.stt = { ...(config.stt ?? {}), autoTranscribe: false }
      writeChannelsConfig(config)
      return "Auto-transcripción STT deshabilitada."
    }

    if (action === "deploy" || action === "start") {
      config.stt = { ...(config.stt ?? {}), managed: true }
      writeChannelsConfig(config)
      const next = normalizeSttConfig(config.stt)
      const result = await deployManagedSttContainer(next)
      return result.ok ? result.message : `Error: ${result.message}`
    }

    if (action === "stop") {
      const result = await stopManagedSttContainer(stt)
      return result.ok ? result.message : `Error: ${result.message}`
    }

    if (action === "remove" || action === "rm") {
      const result = await removeManagedSttContainer(stt)
      return result.ok ? result.message : `Error: ${result.message}`
    }

    if (action === "list" || action === "ls") {
      return await listManagedSttContainers(stt)
    }

    return "Usage: /stt [show|on|off|deploy|stop|remove|list|status]"
  }

  private async runWebSearchCommand(rest: string[]) {
    const config = readWebSearchConfig()
    const action = (rest[0] ?? "show").trim().toLowerCase()

    if (action === "show" || action === "status" || !action) {
      const status = await getSearxngStatus()
      return [
        `Web search mode: ${webSearchProviderLabel(config.provider)}`,
        `SearxNG status: ${status}`,
        `SearxNG URL: ${SEARXNG_URL}`,
        "",
        "Usá /websearch desde la CLI o Telegram para abrir el menú interactivo.",
      ].join("\n")
    }

    if (action === "default") {
      writeWebSearchConfig({ provider: "default" })
      return "Web search mode cambiado a default."
    }

    if (action === "searxng") {
      writeWebSearchConfig({ provider: "searxng" })
      const subaction = (rest[1] ?? "").trim().toLowerCase()
      if (!subaction) {
        const result = await deploySearxngContainer()
        const status = await getSearxngStatus()
        return [
          "Web search mode cambiado a searxng.",
          result.ok ? result.message : `Error: ${result.message}`,
          `SearxNG status: ${status}`,
          `URL: ${SEARXNG_URL}`,
        ].join("\n")
      }
      if (subaction === "list" || subaction === "ls" || subaction === "status") {
        return await listSearxngContainers()
      }
      if (subaction === "stop") {
        const result = await stopSearxngContainer()
        return result.ok ? result.message : `Error: ${result.message}`
      }
      if (subaction === "remove" || subaction === "rm") {
        const result = await removeSearxngContainer(SEARXNG_CONTAINER)
        return result.ok ? result.message : `Error: ${result.message}`
      }
      if (subaction === "clean") {
        const result = await clearAllSearxngContainers()
        return result.ok ? result.message : `Error: ${result.message}`
      }
      if (subaction === "test") {
        const query = rest.slice(2).join(" ").trim()
        if (!query) return "Usage: /websearch searxng test <query>"
        return await testSearxngQuery(query)
      }
      return "Usage: /websearch searxng <list|stop|remove|clean|test <query>>"
    }

    return "Usage: /websearch [show|default|searxng|searxng <list|stop|remove|clean|test <query>>]"
  }

  private async runDoctor(): Promise<string> {
    const lines: string[] = ["=== Monolito V2 Doctor ==="]
    const effective = getEffectiveModelConfig()
    const hasApiKey = effective.apiKey.length > 0
    const hasBaseUrl = effective.baseUrl.length > 0
    const hasModel = effective.model.length > 0
    lines.push(`API Key: ${hasApiKey ? "OK" : "MISSING"}`)
    lines.push(`Base URL: ${hasBaseUrl ? effective.baseUrl : "MISSING"}`)
    lines.push(`Model: ${hasModel ? effective.model : "MISSING"}`)
    lines.push(`Workspace: ${this.rootDir}`)
    try {
      const stats = statSync(join(this.rootDir, "package.json"))
      lines.push(`package.json: OK (${stats.size} bytes)`)
    } catch {
      lines.push("package.json: MISSING")
    }
    lines.push(`Sessions: ${listSessions(this.rootDir).length}`)
    lines.push(`Cost: ${formatCostSummary(this.costState)}`)
    return lines.join("\n")
  }

  private async runUpdate(): Promise<string> {
    const lock = acquireUpdateLock(this.rootDir)
    if (!lock.ok) return lock.message
    try {
      const branch = await runGitCommand(this.rootDir, ["rev-parse", "--abbrev-ref", "HEAD"])
      if (!branch) return "Update failed: could not determine current git branch."

      const remoteUrl = await runGitCommand(this.rootDir, ["remote", "get-url", "origin"]).catch(() => "")
      if (!remoteUrl) {
        return "Update failed: no git remote named 'origin' is configured."
      }

      const status = await runGitCommand(this.rootDir, ["status", "--porcelain"])
      let stashLabel = ""
      if (status.trim()) {
        stashLabel = `monolito-update-backup-${new Date().toISOString()}`
        await runGitCommand(this.rootDir, ["stash", "push", "--include-untracked", "--message", stashLabel])
        const statusAfterStash = await runGitCommand(this.rootDir, ["status", "--porcelain"])
        if (statusAfterStash.trim()) {
          return buildResidualUpdateError(this.rootDir, stashLabel, statusAfterStash)
        }
      }

      const currentHead = await runGitCommand(this.rootDir, ["rev-parse", "HEAD"])
      await runGitCommand(this.rootDir, ["fetch", "--prune", "origin", branch])
      const remoteHead = await runGitCommand(this.rootDir, ["rev-parse", `origin/${branch}`]).catch(() => "")
      if (!remoteHead) {
        return `Update failed: origin/${branch} was not found after fetch.`
      }
      if (currentHead === remoteHead) {
        return [
          `Already up to date on ${branch}.`,
          `Remote: ${remoteUrl}`,
        ].join("\n")
      }

      await runGitCommand(this.rootDir, ["pull", "--ff-only", "origin", branch])
      const nextHead = await runGitCommand(this.rootDir, ["rev-parse", "--short", "HEAD"])
      this.restartRequested = true
      return [
        `Updated successfully from origin/${branch}.`,
        `Remote: ${remoteUrl}`,
        `Current revision: ${nextHead}`,
        stashLabel ? `Local changes were backed up automatically to stash: ${stashLabel}` : "",
        "Daemon restart scheduled automatically.",
      ].filter(Boolean).join("\n")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Update failed: ${message}`
    } finally {
      if (lock.ok) lock.release()
    }
  }

  private async runConfig(rest: string[]): Promise<string> {
    const action = rest[0]
    const settings = readModelSettings()
    const channels = readChannelsConfig()
    if (!action || action === "show") {
      const tts = channels.tts ?? {}
      return JSON.stringify({
        ...redactSensitiveModelSettings(settings),
        tts: {
          baseUrl: typeof tts.baseUrl === "string" ? tts.baseUrl : "",
          apiKey: typeof tts.apiKey === "string" ? maskApiKey(tts.apiKey) : "Not set",
          voice: typeof tts.voice === "string" ? tts.voice : "",
          model: typeof tts.model === "string" ? tts.model : "",
          responseFormat: typeof tts.responseFormat === "string" ? tts.responseFormat : "",
          speed: typeof tts.speed === "number" ? tts.speed : "",
          managed: typeof tts.managed === "boolean" ? tts.managed : "",
          autoDeploy: typeof tts.autoDeploy === "boolean" ? tts.autoDeploy : "",
          port: typeof tts.port === "number" ? tts.port : "",
        },
        stt: {
          managed: typeof channels.stt?.managed === "boolean" ? channels.stt.managed : "",
          autoDeploy: typeof channels.stt?.autoDeploy === "boolean" ? channels.stt.autoDeploy : "",
          autoTranscribe: typeof channels.stt?.autoTranscribe === "boolean" ? channels.stt.autoTranscribe : "",
          port: typeof channels.stt?.port === "number" ? channels.stt.port : "",
          model: typeof channels.stt?.model === "string" ? channels.stt.model : "",
          language: typeof channels.stt?.language === "string" ? channels.stt.language : "",
          engine: typeof channels.stt?.engine === "string" ? channels.stt.engine : "",
          vadFilter: typeof channels.stt?.vadFilter === "boolean" ? channels.stt.vadFilter : "",
        },
      }, null, 2)
    }
    if (action === "set") {
      const field = rest[1]
      const value = rest.slice(2).join(" ")
      if (!field || !value) return "Usage: /config set <field> <value>"
      const draft = settingsToDraft(settings)
      if (field === "base_url") draft.baseUrl = value
      else if (field === "api_key") draft.apiKey = value
      else if (field === "model") draft.model = value
      else if (field === "tts_base_url" || field === "tts_api_key" || field === "tts_voice" || field === "tts_model" || field === "tts_format" || field === "tts_speed" || field === "tts_managed" || field === "tts_auto_deploy" || field === "tts_port") {
        const nextChannels = { ...channels, tts: { ...(channels.tts ?? {}) } }
        if (field === "tts_base_url") nextChannels.tts.baseUrl = value
        if (field === "tts_api_key") nextChannels.tts.apiKey = value
        if (field === "tts_voice") nextChannels.tts.voice = value
        if (field === "tts_model") nextChannels.tts.model = value
        if (field === "tts_managed") {
          if (!["true", "false", "on", "off", "yes", "no", "1", "0"].includes(value.toLowerCase())) {
            return "Invalid: tts_managed must be true or false"
          }
          nextChannels.tts.managed = ["true", "on", "yes", "1"].includes(value.toLowerCase())
        }
        if (field === "tts_auto_deploy") {
          if (!["true", "false", "on", "off", "yes", "no", "1", "0"].includes(value.toLowerCase())) {
            return "Invalid: tts_auto_deploy must be true or false"
          }
          nextChannels.tts.autoDeploy = ["true", "on", "yes", "1"].includes(value.toLowerCase())
        }
        if (field === "tts_format") {
          if (!["mp3", "opus", "aac", "flac", "wav", "pcm"].includes(value)) {
            return "Invalid: tts_format must be one of mp3, opus, aac, flac, wav, pcm"
          }
          nextChannels.tts.responseFormat = value as "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm"
        }
        if (field === "tts_speed") {
          const parsed = Number(value)
          if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 4) {
            return "Invalid: tts_speed must be a number between 0 and 4"
          }
          nextChannels.tts.speed = parsed
        }
        if (field === "tts_port") {
          const parsed = Number(value)
          if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
            return "Invalid: tts_port must be a number between 1 and 65535"
          }
          nextChannels.tts.port = Math.trunc(parsed)
        }
        writeChannelsConfig(nextChannels)
        return `Saved ${field} = ${field === "tts_api_key" ? maskApiKey(value) : value}`
      } else if (field === "stt_managed" || field === "stt_auto_deploy" || field === "stt_auto_transcribe" || field === "stt_port" || field === "stt_model" || field === "stt_language" || field === "stt_engine" || field === "stt_vad_filter") {
        const nextChannels = { ...channels, stt: { ...(channels.stt ?? {}) } }
        const isTruthy = ["true", "on", "yes", "1"].includes(value.toLowerCase())
        const isBoolLike = ["true", "false", "on", "off", "yes", "no", "1", "0"].includes(value.toLowerCase())
        if (field === "stt_managed") {
          if (!isBoolLike) return "Invalid: stt_managed must be true or false"
          nextChannels.stt.managed = isTruthy
        }
        if (field === "stt_auto_deploy") {
          if (!isBoolLike) return "Invalid: stt_auto_deploy must be true or false"
          nextChannels.stt.autoDeploy = isTruthy
        }
        if (field === "stt_auto_transcribe") {
          if (!isBoolLike) return "Invalid: stt_auto_transcribe must be true or false"
          nextChannels.stt.autoTranscribe = isTruthy
        }
        if (field === "stt_vad_filter") {
          if (!isBoolLike) return "Invalid: stt_vad_filter must be true or false"
          nextChannels.stt.vadFilter = isTruthy
        }
        if (field === "stt_port") {
          const parsed = Number(value)
          if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
            return "Invalid: stt_port must be a number between 1 and 65535"
          }
          nextChannels.stt.port = Math.trunc(parsed)
        }
        if (field === "stt_model") nextChannels.stt.model = value
        if (field === "stt_language") nextChannels.stt.language = value
        if (field === "stt_engine") {
          if (!["faster_whisper", "openai_whisper", "whisperx"].includes(value)) {
            return "Invalid: stt_engine must be one of faster_whisper, openai_whisper, whisperx"
          }
          nextChannels.stt.engine = value as "faster_whisper" | "openai_whisper" | "whisperx"
        }
        writeChannelsConfig(nextChannels)
        return `Saved ${field} = ${value}`
      } else {
        return `Unknown field: ${field}`
      }
      const errors = validateModelDraft(draft, process.env)
      if (errors.length > 0) return `Invalid: ${errors[0]}`
      const next = draftToSettings(draft, { env: process.env })
      saveModelSettings(next)
      applyModelSettingsToEnv(process.env, next)
      return `Saved ${field} = ${field === "api_key" ? maskApiKey(value) : value}`
    }
    return "Usage: /config [show | set <field> <value>]"
  }

  // --- Public query methods (for CLI local commands) ---
  queryCost() {
    return formatCostSummary(this.costState)
  }

  queryStats(sessionId: string) {
    const stats = getSessionStats(this.rootDir, sessionId)
    if (!stats) return "Session not found."
    return [
      `Messages: ${stats.messageCount}`,
      `Characters: ${stats.totalChars.toLocaleString()}`,
      `Worklog entries: ${stats.worklogEntries}`,
      `Created: ${stats.createdAt}`,
      `Updated: ${stats.updatedAt}`,
      `State: ${stats.state}`,
    ].join("\n")
  }

  queryCompact(sessionId: string, maxMessages?: number) {
    const result = compactSession(this.rootDir, sessionId, maxMessages ? { maxMessages } : {})
    return `Compacted ${result.compacted} message${result.compacted !== 1 ? "s" : ""}. ${result.remaining} remaining.`
  }

  queryDoctor() {
    return this.runDoctor()
  }

  queryModelInfo() {
    const settings = readModelSettings()
    const effective = getEffectiveModelConfig()
    return [
      `Protocol: ${settings.modelConfig.protocol}`,
      `Base URL: ${effective.baseUrl || "(system/default)"}`,
      `API key: ${maskApiKey(effective.apiKey)}`,
      `Model: ${effective.model || "(unset)"}`,
    ].join("\n")
  }

  async queryConfig(action?: string, field?: string, value?: string) {
    return await this.runConfig(action ? [action, field, value].filter(Boolean) as string[] : [])
  }
}

function clipForWorklog(value: string, maxChars = 180) {
  const trimmed = value.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars).trimEnd()}...`
}
