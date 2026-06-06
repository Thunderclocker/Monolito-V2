import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { z, type ZodType } from "zod"
import { ensureDirs, getPaths } from "../ipc/protocol.ts"
import { MONOLITO_ROOT } from "../system/root.ts"
import { type McpClient, createMcpClient, getDefaultMcpServers } from "../mcp/client.ts"
import { getSharedLspClient } from "../lsp/client.ts"
import { normalizeChannelsConfigForWrite, readChannelsConfig, writeChannelsConfig } from "../channels/config.ts"
import {
  appendActionLog,
  addGraphTriple,
  fileMemory,
  invalidateGraphTriple,
  queryGraphEntity,
  recallMemory,
  listWings,
  listRooms,
  listProfiles,
  createProfile,
  readBootWing,
  writeBootWing,
  listBootWings,
  createBootWing,
  bootWingExists,
  ensureBootWings,
  readConfigWing,
  writeConfigWing,
  getSession,
  listSessions,
  tailEvents,
  writeSessionSource,
  writeSessionTask,
  listSessionTasks,
  deleteSessionTask,
  getDb,
  type SessionTask,
  upsertSemanticTool,
  querySemanticTools,
  upsertRalphRule,
  listDynamicSkills,
  saveDynamicSkill,
  getDynamicSkill,
  deleteDynamicSkill,
  incrementSkillTelemetry,
  archiveDynamicSkill,
  restoreArchivedSkill,
} from "../session/store.ts"
import { isEmbeddingsUnavailableError } from "../session/embeddings.ts"
import { type AgentOrchestrator } from "../runtime/orchestrator.ts"
import { redactSensitiveValue } from "../security/redact.ts"
import { type Logger } from "../logging/logger.ts"
import { CONFIG_WING_ORDER, type ConfigWingName } from "../config/configWings.ts"
import { coerceConfigRecord } from "../config/wingValue.ts"
import { loadAndApplyModelSettings, readModelSettings } from "../runtime/modelConfig.ts"
import { getActiveProfile, activateProfile } from "../runtime/modelRegistry.ts"
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
  transcribeManagedAudioFile,
} from "../stt/managed.ts"
import { deploySearxng, SEARXNG_URL } from "../websearch/managed.ts"
import { readWebSearchConfig } from "../websearch/config.ts"
import { isBootWingName, BOOT_WING_ORDER } from "../bootstrap/bootWings.ts"

const execFileAsync = promisify(execFile)
const DEFAULT_GREP_LIMIT = 250
const DEFAULT_BASH_TIMEOUT_MS = 120_000
const MAX_EXEC_BUFFER = 4 * 1024 * 1024
const TELEGRAM_AUDIO_FORMATS = new Set(["mp3", "m4a", "aac"])
const TELEGRAM_VOICE_FORMATS = new Set(["ogg", "opus"])
const TTS_RESPONSE_FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"])

export function formatToolError(error: unknown): string {
  return JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  })
}

const configWingZod = z.enum([...CONFIG_WING_ORDER] as [ConfigWingName, ...ConfigWingName[]])
const strictRecordZod = z.record(z.string(), z.unknown())
const modelProfileZod = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.enum(["minimax", "ollama", "openai_compatible", "anthropic_compatible"]),
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string().min(1),
  active: z.boolean(),
}).strict()
const modelRegistryZod = z.object({
  version: z.literal(1),
  profiles: z.array(modelProfileZod),
}).strict()
const systemConfigZod = z.object({
  modelConfig: z.object({
    protocol: z.string().min(1),
  }).strict(),
  env: z.object({
    ANTHROPIC_BASE_URL: z.string(),
    ANTHROPIC_AUTH_TOKEN: z.string(),
    ANTHROPIC_MODEL: z.string(),
    API_TIMEOUT_MS: z.string(),
    MAX_BUDGET_USD: z.string(),
  }).strict(),
}).strict()
const webSearchConfigZod = z.object({
  provider: z.enum(["default", "searxng", "brave", "serper", "tavily"]),
  apiKey: z.string().optional(),
}).strict()
const hookMatcherZod = z.object({
  tool: z.string().optional(),
  input: z.string().optional(),
  session: z.string().optional(),
  profile: z.string().optional(),
}).strict()
const hookDefinitionZod = z.object({
  matcher: hookMatcherZod.optional(),
  commands: z.array(z.object({ cmd: z.string().min(1) }).strict()),
}).strict()
const policyConfigZod = z.object({
  permissions: z.object({
    mode: z.enum(["default", "acceptEdits", "bypassPermissions"]),
    rules: z.array(z.object({
      tool: z.string().optional(),
      action: z.enum(["allow", "deny", "ask"]),
      input: z.string().optional(),
    }).strict()),
  }).strict(),
  hooks: z.object({
    PreToolUse: z.array(hookDefinitionZod),
    PostToolUse: z.array(hookDefinitionZod),
    SessionStart: z.array(hookDefinitionZod),
    SessionEnd: z.array(hookDefinitionZod),
  }).strict(),
}).strict()
const bootWriteInputZod = z.object({
  wing: z.string().min(1),
  content: z.string(),
  action: z.enum(["overwrite", "append"]).optional().default("overwrite"),
}).strict()
const bootCreateWingInputZod = z.object({
  wing: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/, "wing must be alphanumeric/snake_case and start with a letter"),
}).strict()
const manageConfigInputZod = z.object({
  action: z.enum(["read", "write", "get", "set", "activate_model"]),
  wing: configWingZod.optional(),
  path: z.string().optional(),
  value: z.unknown().optional(),
}).strict().superRefine((input, ctx) => {
  if (input.action !== "activate_model" && !input.wing) {
    ctx.addIssue({
      code: "custom",
      path: ["wing"],
      message: "wing is required for actions other than activate_model",
    })
  }
  if (input.action === "write" && input.value === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["value"],
      message: "value is required when action='write'",
    })
  }
  if (input.action === "set" && input.path === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["path"],
      message: "path is required when action='set'",
    })
  }
  if (input.action === "set" && input.value === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["value"],
      message: "value is required when action='set'",
    })
  }
  if (input.action === "get" && input.path === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["path"],
      message: "path is required when action='get'",
    })
  }
  if (input.action === "activate_model" && input.value === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["value"],
      message: "value (profileId) is required when action='activate_model'",
    })
  }
})

function normalizeIntentText(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function isImageIntentText(value: string) {
  return /\b(imagen(?:es)?|foto(?:s)?|picture(?:s)?|photo(?:s)?|image(?:s)?|vision|visual)\b/.test(normalizeIntentText(value))
}

function isTelegramPhotoDeliveryRequest(value: string) {
  const normalized = normalizeIntentText(value)
  return isImageIntentText(value) && /\b(pasame|pasa(?:me)?|mandame|manda(?:me)?|enviame|envia(?:me)?|send|send me|pasar|mandar|enviar)\b/.test(normalized)
}

function requiresImageVerificationText(value: string) {
  const normalized = normalizeIntentText(value)
  return /\b(verifica(?:r|me|las|los)?|valid(?:a|ar|ame|alas|alos)|analiza(?:r|me|las|los)?|describe(?:me|las|los)?|confirm(?:a|ar|ame)|vision|visual|coincid(?:e|an)|contenido|real(?:es)?|correct(?:a|as|o|os))\b/.test(normalized)
}

function latestActionableUserText(rootDir: string, sessionId: string) {
  const session = getSession(rootDir, sessionId)
  const message = session?.messages
    .filter(entry => entry.role === "user")
    .slice()
    .reverse()
    .find(entry => {
      const text = entry.text.trim()
      return text && !text.startsWith("<task-notification>") && !text.startsWith("/")
    })
  return message?.text ?? ""
}

function buildTelegramPhotoWorkerTask(task: string, parentSessionId: string, latestUserText: string) {
  const chatId = parentSessionId.startsWith("telegram-") ? parentSessionId.slice("telegram-".length) : ""
  if (!chatId) return task
  const shouldVerify = requiresImageVerificationText(`${latestUserText}\n${task}`)
  const imageHandlingSteps = shouldVerify
    ? [
        "2. Como el pedido exige verificacion visual, validá cada candidato con VisionAnalyze (usando el modelo activo, sea Anthropic, OpenAI-compatible o Grok). Si el modelo activo no soporta visión, la herramienta devuelve un error claro: reportalo y pedí al usuario cambiar de modelo antes de seguir. Descartá cualquier resultado sin descripción útil o que no coincida con el pedido.",
        "3. NO envíes mensajes ni archivos al usuario. Tu salida es solo para el coordinador.",
        "4. Devolvé los local_path validados por la herramienta y una descripción breve de cada imagen.",
        "5. No devuelvas solo URLs si el usuario pidió verificación; el coordinador necesita local_path validado.",
        "6. Si no lográs validar ninguna foto, respondé claramente que no hay local_path validado y por qué.",
      ]
    : [
        "2. NO uses VisionAnalyze salvo que el pedido original solicite verificacion/analisis visual.",
        "3. NO uses WebFetch ni scraping de paginas fuente. Usá directamente los `image_url` que devuelve ImageSearch.",
        "4. NO envíes mensajes ni archivos al usuario. Tu salida es solo para el coordinador.",
        "5. Devolvé las mejores `image_url` directas, con título/fuente si están disponibles.",
        "6. Si no lográs obtener URLs directas, respondé claramente que no hubo resultados usables y por qué.",
      ]
  return [
    "Tarea interna de obtención y verificación de fotos para entrega por Telegram.",
    "",
    "Pedido original del usuario:",
    latestUserText.trim() || task.trim(),
    "",
    "Contrato obligatorio:",
    "1. Usá ImageSearch para buscar candidatos directos de imagen (`image_url`).",
    ...imageHandlingSteps,
    "",
    "Instrucción generada originalmente por el coordinador:",
    task.trim(),
  ].join("\n")
}

export type ToolContext = {
  rootDir: string
  cwd: string
  abortSignal?: AbortSignal
  traceId?: string
  profileId?: string
  getMcpClient?: (serverName: string) => Promise<McpClient>
  orchestrator?: AgentOrchestrator
  logger?: Logger
  sessionId?: string
  // Optional whitelist of tool names the LLM is allowed to call in this turn.
  // Used by SkillsAgent to restrict synthetic turns to lifecycle tools only.
  allowedToolNames?: string[]
  // Set to true for synthetic SkillsAgent turns so tools (e.g. CreateSkill)
  // can mark provenance as "agent" instead of "user".
  isSkillsSynthetic?: boolean
  runtime?: {
    acquireJobGroupForBatch: (sessionId: string) => string
    getSystemStatus?: () => Promise<unknown>
    gracefulRestart?: (reason?: string) => void
    registerPendingPermission?: (permissionId: string, resolve: (decision: "allow" | "deny" | "ask") => void) => void
    emit?: (event: any) => void
  }
  querySessionStatus?: (sessionId: string) => string
  queryCost?: () => string
  queryStats?: (sessionId: string) => string
  compactSession?: (sessionId: string, maxMessages?: number) => string
}

export type ToolInputSchema = {
  type: "object"
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export type ToolDefinition = {
  name: string
  aliases?: string[]
  permissionTier: "read" | "edit"
  description: string
  inputSchema: ToolInputSchema
  concurrencySafe?: boolean | ((input: Record<string, unknown>) => boolean)
  sideEffect?: boolean
  validate?: (input: Record<string, unknown>) => string | null
  run: (input: Record<string, unknown>, context: ToolContext) => Promise<unknown>
}

function withSafeToolFailure(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    async run(input, context) {
      try {
        return await tool.run(input, context)
      } catch (error) {
        return formatToolError(error)
      }
    },
  }
}

const emptyInputSchema: ToolInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
}

const optionalPathInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
  },
  additionalProperties: false,
}

export async function resolveWorkspacePath(
  rootDir: string,
  cwd: string,
  target = ".",
  context?: ToolContext,
  toolName?: string,
) {
  return resolve(cwd, target)
}

function toWorkspaceRelative(rootDir: string, absolute: string) {
  const relativePath = relative(rootDir, absolute)
  return relativePath.length === 0 ? "." : relativePath
}

function normalizePathInput(input: Record<string, unknown>, key = "path") {
  const value = input[key]
  return typeof value === "string" && value.length > 0 ? value : "."
}

function buildTraceEnv(traceId?: string) {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.OPENAI_API_KEY
  if (traceId) env.TRACEPARENT = traceId
  return env
}

function requireString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`)
  }
  return value
}

function optionalString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function optionalNumber(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function isVisionConnectionFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(fetch failed|econnrefused|local vision service unavailable|connect|timed? out|timeout)\b/i.test(message)
}

function truncateText(value: string, max = 220) {
  const compact = compactWhitespace(value)
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 3))}...` : compact
}

function stringifyValue(value: unknown, max = 220) {
  if (typeof value === "string") return truncateText(value, max)
  try {
    return truncateText(JSON.stringify(value), max)
  } catch {
    return truncateText(String(value), max)
  }
}

function decodeBasicHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (match, code: string) => {
      const parsed = Number(code)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => {
      const parsed = Number.parseInt(code, 16)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match
    })
}

function htmlToReadableText(html: string) {
  return decodeBasicHtmlEntities(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function promptTerms(prompt: string) {
  const stopwords = new Set([
    "para", "por", "con", "una", "uno", "unos", "unas", "del", "las", "los", "the",
    "and", "for", "from", "that", "this", "especially", "sobre", "como", "cual", "cuál",
  ])
  return Array.from(new Set(prompt
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[a-z0-9]{4,}/g) ?? []))
    .filter(term => !stopwords.has(term))
}

function selectRelevantText(content: string, prompt: string, maxChars: number) {
  if (content.length <= maxChars) return content

  const normalizedContent = content
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  const terms = promptTerms(prompt)
  const anchors = terms
    .flatMap(term => {
      const positions: number[] = []
      let from = 0
      while (positions.length < 20) {
        const index = normalizedContent.indexOf(term, from)
        if (index === -1) break
        positions.push(index)
        from = index + term.length
      }
      return positions
    })
    .sort((a, b) => a - b)

  if (anchors.length === 0) return `${content.slice(0, maxChars).trimEnd()}\n...[truncated]`

  const windowSize = Math.min(1800, Math.max(700, Math.floor(maxChars / 3)))
  const scored = anchors.map(anchor => {
    const start = Math.max(0, anchor - Math.floor(windowSize / 3))
    const end = Math.min(content.length, start + windowSize)
    const windowText = normalizedContent.slice(start, end)
    const score = terms.reduce((sum, term) => sum + (windowText.includes(term) ? 1 : 0), 0)
    return { start, end, score }
  })
    .sort((a, b) => b.score - a.score || a.start - b.start)

  const selected: Array<{ start: number; end: number }> = []
  for (const candidate of scored) {
    if (selected.some(range => candidate.start < range.end && candidate.end > range.start)) continue
    selected.push({ start: candidate.start, end: candidate.end })
    const used = selected.reduce((sum, range) => sum + range.end - range.start, 0)
    if (used >= maxChars) break
  }

  return selected
    .sort((a, b) => a.start - b.start)
    .map(range => {
      const prefix = range.start > 0 ? "... " : ""
      const suffix = range.end < content.length ? " ..." : ""
      return `${prefix}${content.slice(range.start, range.end).trim()}${suffix}`
    })
    .join("\n\n---\n\n")
    .slice(0, maxChars)
    .trimEnd()
}

type ForensicsIntent = "auto" | "history" | "actions" | "delegation" | "origin"

function resolveForensicsIntent(raw: string | undefined): ForensicsIntent {
  switch (raw) {
    case undefined:
    case "auto":
    case "history":
    case "actions":
    case "delegation":
    case "origin":
      return raw ?? "auto"
    default:
      throw new Error(`Unsupported intent: ${raw}`)
  }
}

function inferForensicsIntent(question: string | undefined): ForensicsIntent {
  const normalized = compactWhitespace(question ?? "").toLowerCase()
  if (!normalized) return "actions"
  if (/\b(worker|workers|agent|agente|sub.?agente|delegat|deleg|parallel|paralelo|spawn)\b/.test(normalized)) return "delegation"
  if (/\b(de donde|de dónde|origen|source|fuente|salio|salió|conclusion|conclusión)\b/.test(normalized)) return "origin"
  if (/\b(que dije|qué dije|que dijo|qué dijo|mensaje|conversation|conversaci|chat|historial)\b/.test(normalized)) return "history"
  return "actions"
}

function pickForensicsSession(rootDir: string, profileId: string | undefined, preferredSessionId: string | undefined) {
  if (preferredSessionId) {
    const exact = getSession(rootDir, preferredSessionId)
    if (!exact) throw new Error(`Session ${preferredSessionId} not found`)
    return exact
  }
  const sessions = listSessions(rootDir, profileId)
  if (sessions.length === 0) throw new Error("No sessions available for forensics")
  const latest = getSession(rootDir, sessions[0]!.id)
  if (!latest) throw new Error(`Session ${sessions[0]!.id} not found`)
  return latest
}

function buildEventLine(event: Record<string, unknown>) {
  const type = typeof event.type === "string" ? event.type : "unknown"
  switch (type) {
    case "tool.start":
      return `${type}: ${(event.tool as string) ?? "unknown"} started`
    case "tool.finish":
      return `${type}: ${(event.tool as string) ?? "unknown"} ${event.ok === true ? "ok" : "failed"}${event.output !== undefined ? ` -> ${stringifyValue(event.output, 160)}` : ""}`
    case "agent.background.completed":
      return `${type}: ${(event.agentId as string) ?? "unknown"} ${(event.status as string) ?? "unknown"}${event.result ? ` -> ${stringifyValue(event.result, 160)}` : ""}${event.error ? ` error=${stringifyValue(event.error, 120)}` : ""}`
    case "message.received":
      return `${type}: ${(event.role as string) ?? "unknown"} -> ${truncateText(String(event.text ?? ""), 160)}`
    case "error":
      return `${type}: ${truncateText(String(event.error ?? ""), 160)}`
    default:
      return `${type}: ${stringifyValue(event, 180)}`
  }
}

function uniqueLines(lines: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of lines) {
    const normalized = compactWhitespace(line)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function optionalBoolean(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "boolean" ? value : undefined
}

function findStringOccurrences(content: string, needle: string) {
  const matches: Array<{ index: number; line: number }> = []
  let fromIndex = 0
  while (true) {
    const index = content.indexOf(needle, fromIndex)
    if (index === -1) break
    const line = content.slice(0, index).split("\n").length
    matches.push({ index, line })
    fromIndex = index + needle.length
  }
  return matches
}

function zodErrorMessage(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")
  }
  return error instanceof Error ? error.message : String(error)
}

function parseZod<T>(schema: ZodType<T>, value: unknown, label: string): T {
  try {
    return schema.parse(value)
  } catch (error) {
    throw new Error(`${label} failed validation: ${zodErrorMessage(error)}`)
  }
}

function validateZod<T>(schema: ZodType<T>, value: unknown) {
  const result = schema.safeParse(value)
  return result.success ? null : zodErrorMessage(result.error)
}

function normalizeConfigWingValue(wing: ConfigWingName, value: unknown) {
  if (wing === "CONF_CHANNELS") {
    parseZod(strictRecordZod, value, "CONF_CHANNELS")
    return normalizeChannelsConfigForWrite(value)
  }
  if (wing === "CONF_MODELS") {
    return parseZod(modelRegistryZod, coerceConfigRecord(value) ?? value, "CONF_MODELS")
  }
  if (wing === "CONF_SYSTEM") {
    return parseZod(systemConfigZod, coerceConfigRecord(value) ?? value, "CONF_SYSTEM")
  }
  if (wing === "CONF_WEBSEARCH") {
    return parseZod(webSearchConfigZod, coerceConfigRecord(value) ?? value, "CONF_WEBSEARCH")
  }
  if (wing === "CONF_MCP") {
    return parseZod(strictRecordZod, coerceConfigRecord(value) ?? value, "CONF_MCP")
  }
  if (wing === "CONF_POLICY") {
    return parseZod(policyConfigZod, coerceConfigRecord(value) ?? value, "CONF_POLICY")
  }
  return value
}

function parseJsonStringValue(value: unknown) {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if (!trimmed) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function objectArrayField(value: unknown, key: string): Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const candidate = (value as Record<string, unknown>)[key]
  if (!Array.isArray(candidate)) return []
  return candidate.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item),
  )
}

function inferExtensionFromFormat(format: string) {
  if (format === "opus") return "ogg"
  return format
}

function sanitizeFilenameSegment(value: string) {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-")
  return normalized.replace(/^-+|-+$/g, "") || "speech"
}

async function telegramApiCall(token: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  })
  return await response.json() as { ok: boolean; result?: unknown; description?: string }
}

const TELEGRAM_SENT_PHOTOS_KEY = "telegram_sent_photos"

function getAlreadySentPhotos(rootDir: string): Set<string> {
  try {
    const stateFile = join(rootDir, "run", `${TELEGRAM_SENT_PHOTOS_KEY}.json`)
    if (existsSync(stateFile)) {
      const data = JSON.parse(readFileSync(stateFile, "utf8")) as string[]
      return new Set(data)
    }
  } catch {}
  return new Set()
}

function markPhotoAsSent(rootDir: string, photoPath: string) {
  try {
    const stateFile = join(rootDir, "run", `${TELEGRAM_SENT_PHOTOS_KEY}.json`)
    const sent = getAlreadySentPhotos(rootDir)
    sent.add(photoPath)
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, JSON.stringify([...sent]), "utf8")
  } catch {}
}

function isPhotoAlreadySent(rootDir: string, photoPath: string): boolean {
  return getAlreadySentPhotos(rootDir).has(photoPath)
}

function isLocalPath(value: string) {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/")
}

function resolveMonolitoPath(pathStr: string): string {
  const index = pathStr.indexOf(".monolito-v2")
  if (index !== -1) {
    const relativePart = pathStr.slice(index + ".monolito-v2".length)
    return join(MONOLITO_ROOT, relativePart)
  }
  return pathStr
}

async function telegramApiCallWithFile(
  token: string,
  method: string,
  fileField: string,
  filePath: string,
  params: Record<string, unknown>,
) {
  let resolvedPath = filePath.startsWith("~/")
    ? filePath.replace("~/", `${process.env.HOME ?? ""}/`)
    : filePath

  resolvedPath = resolveMonolitoPath(resolvedPath)

  if (!existsSync(resolvedPath)) {
    return { ok: false, description: `File not found: ${resolvedPath}` }
  }

  const fileData = readFileSync(resolvedPath)
  const fileName = resolvedPath.split("/").at(-1) ?? "upload.bin"
  const formData = new FormData()
  formData.append(fileField, new Blob([fileData]), fileName)

  for (const [key, value] of Object.entries(params)) {
    if (key === fileField) continue
    if (value !== undefined && value !== null) {
      formData.append(key, typeof value === "object" ? JSON.stringify(value) : String(value))
    }
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(30_000),
  })
  return await response.json() as { ok: boolean; result?: unknown; description?: string }
}

async function resolveTelegramDownload(
  token: string,
  fileId: string,
  rootDir: string,
  filename?: string,
) {
  const paths = ensureDirs(rootDir)
  const downloadsDir = join(paths.scratchpadDir, "telegram-downloads")
  if (existsSync(downloadsDir)) {
    const existingFiles = readdirSync(downloadsDir)
    const match = existingFiles.find(name => name.includes(fileId.slice(0, 8)))
    if (match) {
      const localPath = join(downloadsDir, match)
      try {
        const stats = statSync(localPath)
        return {
          ok: true,
          file_id: fileId,
          local_path: localPath,
          bytes: stats.size,
          cached: true,
        }
      } catch {
        // Fall back to downloading if stat fails.
      }
    }
  }

  const fileInfo = await telegramApiCall(token, "getFile", { file_id: fileId })
  if (!fileInfo.ok || !fileInfo.result || typeof fileInfo.result !== "object") {
    throw new Error(`Failed to get Telegram file info: ${fileInfo.description ?? "unknown error"}`)
  }

  const result = fileInfo.result as { file_path?: string }
  if (!result.file_path) {
    throw new Error("Telegram did not return file_path for this file_id.")
  }

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${result.file_path}`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: HTTP ${response.status}`)
  }

  mkdirSync(downloadsDir, { recursive: true })
  const originalName = result.file_path.split("/").at(-1) ?? fileId
  const extension = originalName.includes(".") ? `.${originalName.split(".").at(-1)}` : ""
  const saveName = filename
    ? (filename.includes(".") ? filename : `${filename}${extension}`)
    : originalName
  const localPath = join(downloadsDir, saveName)
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(localPath, buffer)

  return {
    ok: true,
    file_id: fileId,
    file_path: result.file_path,
    local_path: localPath,
    bytes: buffer.length,
  }
}

async function runRg(args: string[], cwd: string) {
  try {
    return await execFileAsync("rg", args, {
      cwd,
      maxBuffer: MAX_EXEC_BUFFER,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    })
  } catch (error) {
    const typed = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }
    if (typed.code === 1) {
      return { stdout: typed.stdout ?? "", stderr: typed.stderr ?? "" }
    }
    if (typed.code === "ENOENT") {
      throw new Error("rg is required but not installed")
    }
    throw error
  }
}

async function getMcpClient(context: ToolContext, serverName: string) {
  if (context.getMcpClient) return context.getMcpClient(serverName)
  const server = getDefaultMcpServers(context.rootDir)[serverName]
  if (!server) throw new Error(`Unknown MCP server: ${serverName}`)
  const client = createMcpClient(server)
  await client.initialize()
  return client
}

async function fetchWithCurl(url: string) {
  const result = await execFileAsync("curl", ["-fsSL", "--max-time", "15", url], {
    maxBuffer: MAX_EXEC_BUFFER,
    env: process.env,
  })
  return {
    code: 200,
    codeText: "OK",
    bytes: Buffer.byteLength(result.stdout),
    content: result.stdout,
  }
}

/**
 * Helper to convert local time components in a specific IANA timezone to a UTC Date.
 * 
 * Works by:
 * 1. Treating the local time components as a UTC time first.
 * 2. Formatting this UTC candidate in the target timezone to find the local components of that instant.
 * 3. Computing the difference (offset) between the target local time and the candidate's local time.
 * 4. Applying this difference to the candidate to get the exact UTC Date.
 */
function localTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string
): Date {
  const utcCandidateMs = Date.UTC(year, month - 1, day, hour, minute, second)
  
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  })
  
  const parts = formatter.formatToParts(new Date(utcCandidateMs))
  const partVal = (type: string) => parseInt(parts.find(p => p.type === type)!.value, 10)
  
  const localYear = partVal("year")
  const localMonth = partVal("month")
  const localDay = partVal("day")
  const localHour = partVal("hour") % 24
  const localMinute = partVal("minute")
  const localSecond = partVal("second")
  
  const localCandidateMs = Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, localSecond)
  const offsetMs = utcCandidateMs - localCandidateMs
  
  return new Date(utcCandidateMs + offsetMs)
}

/**
 * Parses an absolute time string (e.g. "15:30", "2026-05-18 10:00") in the context of the
 * user's timezone and returns a UTC Date.
 */
function parseAbsoluteTimeToUtc(timeStr: string, timezone: string): Date {
  const trimmed = timeStr.trim()
  const now = new Date()

  // 1. Try Full Date-Time (e.g., "2026-05-17 15:30:00" or "2026-05-17T15:30")
  const fullDateTimeRegex = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/
  const matchFull = trimmed.match(fullDateTimeRegex)
  if (matchFull) {
    const year = parseInt(matchFull[1]!, 10)
    const month = parseInt(matchFull[2]!, 10)
    const day = parseInt(matchFull[3]!, 10)
    const hour = parseInt(matchFull[4]!, 10)
    const minute = parseInt(matchFull[5]!, 10)
    const second = matchFull[6] ? parseInt(matchFull[6]!, 10) : 0
    return localTimeToUtc(year, month, day, hour, minute, second, timezone)
  }

  // 2. Try Time Only (e.g., "15:30" or "15:30:00")
  const timeOnlyRegex = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
  const matchTime = trimmed.match(timeOnlyRegex)
  if (matchTime) {
    const hour = parseInt(matchTime[1]!, 10)
    const minute = parseInt(matchTime[2]!, 10)
    const second = matchTime[3] ? parseInt(matchTime[3]!, 10) : 0

    // Retrieve the current date components inside the target timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    })
    const parts = formatter.formatToParts(now)
    const partVal = (type: string) => parseInt(parts.find(p => p.type === type)!.value, 10)
    const currentYear = partVal("year")
    const currentMonth = partVal("month")
    const currentDay = partVal("day")

    let targetDate = localTimeToUtc(currentYear, currentMonth, currentDay, hour, minute, second, timezone)
    // If the target time today has already passed, schedule it for tomorrow
    if (targetDate.getTime() <= now.getTime()) {
      targetDate = localTimeToUtc(currentYear, currentMonth, currentDay + 1, hour, minute, second, timezone)
    }
    return targetDate
  }

  throw new Error(`Invalid absolute time format: "${timeStr}". Expected "HH:MM", "HH:MM:SS", "YYYY-MM-DD HH:MM" or "YYYY-MM-DD HH:MM:SS".`)
}

const scheduleTaskInputZod = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
  }).strict(),
  z.object({
    action: z.literal("remove"),
    job_index: z.number().int().min(1, "job_index must be >= 1"),
  }).strict(),
  z.object({
    action: z.literal("add"),
    message: z.string().min(1, "message is required and cannot be empty"),
    chat_id: z.number(),
    timezone: z.string().min(1, "timezone is required when adding a task"),
    delay_seconds: z.number().min(0, "delay_seconds must be >= 0").optional(),
    at: z.string().min(1).optional(),
    time: z.string().min(1).optional(),
    cron_expression: z.string().min(1).optional(),
  }).strict().superRefine((data, ctx) => {
    const providedTriggers = [
      data.delay_seconds !== undefined,
      data.at !== undefined,
      data.time !== undefined,
      data.cron_expression !== undefined,
    ].filter(Boolean).length

    if (providedTriggers === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either delay_seconds, at/time, or cron_expression must be provided",
        path: ["delay_seconds"],
      })
    } else if (providedTriggers > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "delay_seconds, at, time, and cron_expression are mutually exclusive",
        path: ["delay_seconds"],
      })
    }
  }),
])

// ----- Skills: configuration and security helpers ----------------------------

/**
 * Read the CONF_SKILLS config wing for skill lifecycle settings.
 * Returns sensible defaults if the wing is missing or malformed.
 */
function readSkillGuardConfig(rootDir: string): boolean {
  try {
    const wing = readConfigWing(rootDir, "CONF_SKILLS") as {
      guard_agent_created?: boolean
    } | null
    return wing?.guard_agent_created === true
  } catch {
    return false
  }
}

/**
 * Lightweight threat-pattern scanner for agent-created skill guides.
 * Returns the first matched pattern (or null if clean).
 * This is defensive only — not a sandbox. The agent can still execute
 * anything via Bash; the scan just adds friction against self-inflicted
 * bad SOPs that would otherwise look innocuous.
 */
const SKILL_THREAT_PATTERNS: { name: string; regex: RegExp }[] = [
  // Matches rm with any combination of -r and -f flags in either order, and
  // any dangerous path. Catches:
  //   rm -rf /, rm -fr /, rm -Rf /, rm --remove-files /
  //   rm -rf .         (recursive delete of cwd)
  //   rm -rf /tmp      (recursive delete of /tmp)
  //   rm -rf /etc, /var, /home, /usr, /opt, /root, /srv, /mnt
  //   rm -rf ~         (recursive delete of home)
  //   rm -rf .ssh      (deletes SSH keys)
  { name: "rm recursive dangerous", regex: /\brm\s+(-\w*[rf]\w*[rf]\w*\s+|--\S+\s+)+\.?(\/|\.\.?\/|~\/|\$HOME|\$\{HOME\}|\/tmp|\/etc|\/var|\/home|\/usr|\/opt|\/root|\/srv|\/mnt|\/bin|\/sbin|\/lib|\.ssh|\.\/|\.\.\/)/im },
  // Catches rm -rf / at end of line (legacy) and any rm -rf <path>
  { name: "rm recursive path", regex: /\brm\s+-\w*[rf]\w*[rf]\w*[\s\u00A0]+(?!\/dev\/null)[^\s]/im },
  // Catches shell download-and-execute on any common shell.
  // sh | bash | zsh | ksh | fish | csh | tcsh | dash | ash | oil | elvish | xonsh
  { name: "curl pipe shell", regex: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba)?sh|zsh|ksh|fish|csh|tcsh|dash|ash|oil|elvish|xonsh(?:\s|$)/m },
  { name: "exfiltrate env", regex: /\b(cat|printenv|env)\b[^.\n]*\b(AWS_|GITHUB_|OPENAI_|ANTHROPIC_|API_KEY|SECRET|TOKEN)/m },
  { name: "chmod 777", regex: /\bchmod\s+777\b/ },
  { name: "dd overwrite disk", regex: /\bdd\s+if=[^\n]*\s+of=\/dev\/(sd|nvme|hd|xvd|vd|mmcblk|loop|disk|dasd)/m },
  // Whole-disk wipe via redirections
  { name: "truncate device", regex: />\s*\/dev\/(sd|nvme|hd|xvd|vd|mmcblk|loop|disk|dasd)\b/m },
  // Classic fork bomb
  { name: "fork bomb", regex: /:\(\)\s*\{[^}]*:\s*\|:\s*&?\s*\};:/m },
]

function scanSkillGuideForThreats(guide: string): { threat: boolean; pattern: string | null } {
  for (const { name, regex } of SKILL_THREAT_PATTERNS) {
    if (regex.test(guide)) {
      return { threat: true, pattern: name }
    }
  }
  return { threat: false, pattern: null }
}

/**
 * Debounce window for skill telemetry. If a skill was used less than this many
 * milliseconds ago, skip the increment. Prevents SQLite writes from a tight
 * loop of skill_view calls in the same turn.
 */
const SKILL_TELEMETRY_DEBOUNCE_MS = 60_000

function shouldRecordSkillUse(skill: { telemetry?: { last_used_at?: string; use_count?: number } }): boolean {
  // First use (use_count === 0) always counts. After that, debounce.
  if (!skill.telemetry || (skill.telemetry.use_count ?? 0) === 0) return true
  const last = skill.telemetry.last_used_at
  if (!last) return true
  const lastMs = Date.parse(last)
  if (Number.isNaN(lastMs)) return true
  return Date.now() - lastMs >= SKILL_TELEMETRY_DEBOUNCE_MS
}

const rawTools: ToolDefinition[] = [
  {
    name: "schedule_task",
    permissionTier: "edit",
    description: `Unified tool for scheduling and managing reminders and cron jobs. Always use this tool for anything time/reminder related.

Actions:
- "list": Returns all scheduled recurring cron jobs with their index numbers.
- "add": Adds a new job. Three modes:
    * One-shot relative (delay_seconds): fires once after N seconds.
    * One-shot absolute (at or time): fires once at a specific absolute local time (e.g., '15:30' or '2026-05-18 10:00').
    * Recurring (cron_expression): adds a persistent cron job. Best for 'every day at 8am'.
  Requires: message, chat_id, timezone. Plus either delay_seconds, at/time, OR cron_expression.
- "remove": Removes a recurring cron job by its index (1-based, from "list").`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove"], description: "Operation to perform." },
        message: { type: "string", description: "[add] The reminder/notification text to send via Telegram." },
        chat_id: { type: "number", description: "[add] Telegram chat ID." },
        delay_seconds: { type: "number", description: "[add, one-shot relative] Seconds from now to fire. Mutually exclusive with at, time, and cron_expression." },
        at: { type: "string", description: "[add, one-shot absolute] Absolute time to fire (e.g. '15:30', '2026-05-18 10:00'). Mutually exclusive with delay_seconds, time, and cron_expression. CRITICAL: If the user only specified a time (e.g. '02:31'), pass only that time string '02:31' exactly without calculating or prepending a date, so that the tool can correctly decide if it's today or tomorrow using the user's local timezone." },
        time: { type: "string", description: "[add, one-shot absolute] Alias for 'at'. Absolute time to fire. Mutually exclusive with delay_seconds, at, and cron_expression. CRITICAL: If the user only specified a time (e.g. '02:31'), pass only that time string '02:31' exactly without calculating or prepending a date, so that the tool can correctly decide if it's today or tomorrow using the user's local timezone." },
        cron_expression: { type: "string", description: "[add, recurring] Standard cron expression, e.g. '0 10 * * *' for 10am daily." },
        timezone: { type: "string", description: "[add] The IANA timezone of the user (e.g. 'America/Argentina/Buenos_Aires'). Required when adding any job." },
        job_index: { type: "number", description: "[remove] 1-based index of the cron job to remove (from 'list')." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    validate: input => validateZod(scheduleTaskInputZod, input),
    async run(input) {
      const parsed = parseZod(scheduleTaskInputZod, input, "schedule_task input")
      const action = parsed.action

      // ── LIST ──────────────────────────────────────────────────────────────
      if (action === "list") {
        try {
          const { stdout } = await execFileAsync("crontab", ["-l"])
          if (!stdout.trim()) return "No recurring jobs scheduled."
          const lines = stdout.split("\n")
          const jobs = lines
            .map((line, i) => ({ line: line.trim(), i }))
            .filter(({ line }) => line && !line.startsWith("#") && !line.startsWith("CRON_TZ="))
          if (jobs.length === 0) return "No recurring jobs scheduled."
          return jobs.map(({ line, i: _i }, idx) => `[${idx + 1}] ${line}`).join("\n")
        } catch (error: any) {
          if (error.stderr?.includes("no crontab for")) return "No recurring jobs scheduled."
          throw new Error(error.stderr || error.message)
        }
      }

      // ── REMOVE ────────────────────────────────────────────────────────────
      if (action === "remove") {
        const jobIndex = parsed.job_index
        if (!jobIndex || jobIndex < 1) return formatToolError("job_index is required and must be >= 1")
        let existing = ""
        try {
          const { stdout } = await execFileAsync("crontab", ["-l"])
          existing = stdout
        } catch (error: any) {
          if (!error.stderr?.includes("no crontab for")) throw new Error(error.stderr || error.message)
        }
        const lines = existing.split("\n")
        const jobEntries = lines
          .map((line, originalIndex) => ({ line: line.trim(), originalIndex }))
          .filter(entry => entry.line && !entry.line.startsWith("#") && !entry.line.startsWith("CRON_TZ="))
        if (jobIndex > jobEntries.length) return formatToolError(`Job index ${jobIndex} out of range (only ${jobEntries.length} jobs).`)
        
        const targetEntry = jobEntries[jobIndex - 1]
        const targetIndex = targetEntry.originalIndex
        const targetJob = targetEntry.line
        
        if (targetIndex > 0 && lines[targetIndex - 1].startsWith("CRON_TZ=")) {
          lines.splice(targetIndex - 1, 2)
        } else {
          lines.splice(targetIndex, 1)
        }
        const newContent = lines.join("\n").trim()
        const tempPath = join("/tmp", `crontab-${randomUUID()}`)
        try {
          writeFileSync(tempPath, newContent + "\n")
          await execFileAsync("crontab", [tempPath])
          return `Removed job [${jobIndex}]: ${targetJob}`
        } catch (error: any) {
          throw new Error(`Failed to update crontab: ${error.stderr || error.message}`)
        } finally {
          if (existsSync(tempPath)) try { require("node:fs").unlinkSync(tempPath) } catch {}
        }
      }

      // ── ADD ───────────────────────────────────────────────────────────────
      if (action === "add") {
        const { message, chat_id, timezone, delay_seconds, at, time, cron_expression } = parsed

        // Inject into Monolito's orchestrator session memory so the agent becomes conscious of the reminder
        const cliScript = join(process.cwd(), "src/apps/cli.ts")
        const monolitoCmd = `${process.execPath} --experimental-strip-types "${cliScript}" resume orchestrator -p "RECORDATORIO DEL SISTEMA: ${message.replace(/"/g, '\\"')}"`

        // 1. One-shot relative: delay_seconds
        if (delay_seconds !== undefined) {
          const shellCmd = `sleep ${Math.floor(delay_seconds)} && ${monolitoCmd}`
          const child = spawn("bash", ["-c", shellCmd], { detached: true, stdio: "ignore" })
          child.unref()
          const fireAt = new Date(Date.now() + delay_seconds * 1000)
          const fireAtStr = fireAt.toLocaleTimeString("es-AR", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZone: timezone,
          })
          return `One-shot reminder scheduled for ${fireAtStr} (in ${Math.round(delay_seconds / 60)} min) using timezone ${timezone}.\nMessage: "${message}"`
        }

        // 2. One-shot absolute: at or time
        const absoluteTimeStr = at ?? time
        if (absoluteTimeStr !== undefined) {
          const targetUtcDate = parseAbsoluteTimeToUtc(absoluteTimeStr, timezone)
          const currentUtcMs = Date.now()
          const diffMs = targetUtcDate.getTime() - currentUtcMs
          
          if (diffMs <= 0) {
            return formatToolError("The scheduled absolute time is in the past.")
          }
          
          const computedDelaySeconds = diffMs / 1000
          const shellCmd = `sleep ${Math.floor(computedDelaySeconds)} && ${monolitoCmd}`
          const child = spawn("bash", ["-c", shellCmd], { detached: true, stdio: "ignore" })
          child.unref()
          
          const fireAtStr = targetUtcDate.toLocaleTimeString("es-AR", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZone: timezone,
          })
          return `One-shot absolute reminder scheduled for ${fireAtStr} (in ${Math.round(computedDelaySeconds / 60)} min) using timezone ${timezone}.\nMessage: "${message}"`
        }

        // 3. Recurring: append to crontab
        if (cron_expression !== undefined) {
          let existing = ""
          try {
            const { stdout } = await execFileAsync("crontab", ["-l"])
            existing = stdout
          } catch (error: any) {
            if (!error.stderr?.includes("no crontab for")) throw new Error(error.stderr || error.message)
          }
          const newLine = `CRON_TZ="${timezone}"\n${cron_expression} ${monolitoCmd}`
          const newContent = (existing.trim() ? existing.trimEnd() + "\n" : "") + newLine + "\n"
          const tempPath = join("/tmp", `crontab-${randomUUID()}`)
          try {
            writeFileSync(tempPath, newContent)
            await execFileAsync("crontab", [tempPath])
            return `Recurring job added: ${newLine}`
          } catch (error: any) {
            throw new Error(`Failed to write crontab: ${error.stderr || error.message}`)
          } finally {
            if (existsSync(tempPath)) try { require("node:fs").unlinkSync(tempPath) } catch {}
          }
        }
      }

      return formatToolError(`Unknown action: ${action}`)
    },
  },
  {
    name: "QuerySessionStatus",
    permissionTier: "read",
    description: "Return metadata for the current Monolito session, model configuration, and available tool count.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional session ID. Defaults to the current session." },
      },
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const sessionId = optionalString(input, "sessionId") ?? context.sessionId
      if (!sessionId) return formatToolError("sessionId is required")
      if (!context.querySessionStatus) return formatToolError("Session status query is not available in this context")
      return context.querySessionStatus(sessionId)
    },
  },
  {
    name: "QueryCost",
    permissionTier: "read",
    description: "Return the current Monolito session token and cost summary.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run(_input, context) {
      if (!context.queryCost) return formatToolError("Cost query is not available in this context")
      return context.queryCost()
    },
  },
  {
    name: "QuerySessionStats",
    permissionTier: "read",
    description: "Return usage statistics for a Monolito session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional session ID. Defaults to the current session." },
      },
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const sessionId = optionalString(input, "sessionId") ?? context.sessionId
      if (!sessionId) return formatToolError("sessionId is required")
      if (!context.queryStats) return formatToolError("Session stats query is not available in this context")
      return context.queryStats(sessionId)
    },
  },
  {
    name: "CompactSession",
    permissionTier: "edit",
    description: "Compact older messages in the current Monolito session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional session ID. Defaults to the current session." },
        maxMessages: { type: "number", description: "Optional number of recent messages to keep un-compacted." },
      },
      additionalProperties: false,
    },
    validate: input => {
      const maxMessages = input.maxMessages
      if (maxMessages !== undefined && (typeof maxMessages !== "number" || !Number.isInteger(maxMessages) || maxMessages < 1)) {
        return "maxMessages must be a positive integer"
      }
      return null
    },
    async run(input, context) {
      const sessionId = optionalString(input, "sessionId") ?? context.sessionId
      const maxMessages = optionalNumber(input, "maxMessages")
      if (!sessionId) return formatToolError("sessionId is required")
      if (!context.compactSession) return formatToolError("Session compaction is not available in this context")
      return context.compactSession(sessionId, maxMessages)
    },
  },
  {
    name: "pwd",
    permissionTier: "read",
    description: "Return the current workspace directory.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run(_input, context) {
      return { cwd: context.cwd }
    },
  },
  {
    name: "list_files",
    permissionTier: "read",
    description: "List files in a workspace-relative directory.",
    inputSchema: optionalPathInputSchema,
    concurrencySafe: true,
    async run(input, context) {
      const target = normalizePathInput(input)
      const directory = await resolveWorkspacePath(context.rootDir, context.cwd, target, context, "list_files")
      return readdirSync(directory).map(name => {
        const absolute = join(directory, name)
        const stats = statSync(absolute)
        return {
          name,
          path: toWorkspaceRelative(context.rootDir, absolute),
          type: stats.isDirectory() ? "dir" : "file",
        }
      })
    },
  },
  {
    name: "Read",
    aliases: ["read_file"],
    permissionTier: "read",
    description: "Read a UTF-8 file from the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        line_limit: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.path !== "string" || input.path.length === 0) return "path must be a non-empty string"
      if (input.offset !== undefined && (typeof input.offset !== "number" || !Number.isInteger(input.offset) || input.offset < 0)) {
        return "offset must be a non-negative integer"
      }
      if (input.line_limit !== undefined && (typeof input.line_limit !== "number" || !Number.isInteger(input.line_limit) || input.line_limit < 0)) {
        return "line_limit must be a non-negative integer"
      }
      return null
    },
    async run(input, context) {
      const path = requireString(input, "path")
      const offset = optionalNumber(input, "offset") ?? 0
      const lineLimit = optionalNumber(input, "line_limit")
      const file = await resolveWorkspacePath(context.rootDir, context.cwd, path, context, "Read")
      const content = readFileSync(file, "utf8")
      const lines = content.split("\n")
      const totalLines = lines.length
      const pagedLines = lineLimit === undefined ? lines.slice(offset) : lines.slice(offset, offset + lineLimit)
      return {
        path,
        content: pagedLines.join("\n"),
        totalLines,
        offset,
        lineLimit,
        returnedLines: pagedLines.length,
        hasMore: offset + pagedLines.length < totalLines,
      }
    },
  },
  {
    name: "Write",
    aliases: ["write_file"],
    permissionTier: "edit",
    description: "Create or overwrite a file in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => {
      if (typeof input.path !== "string" || input.path.length === 0) return "path must be a non-empty string"
      if (typeof input.content !== "string" || input.content.length === 0) return "content must be a non-empty string"
      return null
    },
    async run(input, context) {
      const path = requireString(input, "path")
      const content = requireString(input, "content")
      const file = await resolveWorkspacePath(context.rootDir, context.cwd, path, context, "Write")
      mkdirSync(dirname(file), { recursive: true })
      const existed = existsSync(file)
      writeFileSync(file, content, "utf8")
      return { path, type: existed ? "update" : "create", bytes: Buffer.byteLength(content) }
    },
  },
  {
    name: "Edit",
    aliases: ["edit_file"],
    permissionTier: "edit",
    description: "Edit a file in place by replacing an existing string.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
        match_index: { type: "number", description: "Optional 0-based match index to replace when old_string appears multiple times." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => {
      if (typeof input.path !== "string" || input.path.length === 0) return "path must be a non-empty string"
      if (typeof input.old_string !== "string" || input.old_string.length === 0) return "old_string must be a non-empty string"
      if (typeof input.new_string !== "string") return "new_string must be a string"
      if (input.match_index !== undefined && (typeof input.match_index !== "number" || !Number.isInteger(input.match_index) || input.match_index < 0)) {
        return "match_index must be a non-negative integer"
      }
      if (input.match_index !== undefined && input.replace_all === true) {
        return "match_index cannot be combined with replace_all=true"
      }
      return null
    },
    async run(input, context) {
      const path = requireString(input, "path")
      const oldString = requireString(input, "old_string")
      const newString = requireString(input, "new_string")
      const replaceAll = optionalBoolean(input, "replace_all") ?? false
      const matchIndex = optionalNumber(input, "match_index")
      const file = await resolveWorkspacePath(context.rootDir, context.cwd, path, context, "Edit")
      const original = readFileSync(file, "utf8")
      const matches = findStringOccurrences(original, oldString)
      const occurrences = matches.length
      if (occurrences === 0) return formatToolError(`old_string not found in ${path}`)
      if (replaceAll && matchIndex !== undefined) {
        return formatToolError("match_index cannot be combined with replace_all=true")
      }
      if (!replaceAll && occurrences > 1) {
        if (matchIndex === undefined) {
          const lineSummary = matches.map((match, index) => `${index}:${match.line}`).join(", ")
          return formatToolError(`old_string matched ${occurrences} times in ${path} at match_index:line ${lineSummary}; retry with match_index or set replace_all=true`)
        }
        if (!Number.isInteger(matchIndex) || matchIndex < 0 || matchIndex >= occurrences) {
          return formatToolError(`match_index ${matchIndex} is out of range for ${occurrences} matches in ${path}`)
        }
      }
      let updated = original
      let replaced = 0
      if (replaceAll) {
        updated = original.split(oldString).join(newString)
        replaced = occurrences
      } else if (matchIndex !== undefined) {
        const match = matches[matchIndex]
        if (!match) return formatToolError(`match_index ${matchIndex} is out of range for ${occurrences} matches in ${path}`)
        updated = `${original.slice(0, match.index)}${newString}${original.slice(match.index + oldString.length)}`
        replaced = 1
      } else {
        updated = original.replace(oldString, newString)
        replaced = 1
      }
      writeFileSync(file, updated, "utf8")
      return { path, replaced, bytes: Buffer.byteLength(updated) }
    },
  },
  {
    name: "Glob",
    aliases: ["glob"],
    permissionTier: "read",
    description: "Find files by glob pattern inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        head_limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => typeof input.pattern === "string" && input.pattern.length > 0 ? null : "pattern must be a non-empty string",
    async run(input, context) {
      const pattern = requireString(input, "pattern")
      const target = normalizePathInput(input)
      const headLimit = optionalNumber(input, "head_limit") ?? 100
      const offset = optionalNumber(input, "offset") ?? 0
      const absoluteTarget = await resolveWorkspacePath(context.rootDir, context.cwd, target, context, "Find")
      const relativeTarget = toWorkspaceRelative(context.rootDir, absoluteTarget)
      const result = await runRg(["--files", relativeTarget === "." ? "." : relativeTarget, "-g", pattern], context.rootDir)
      const matches = result.stdout.split("\n").map(line => line.trim()).filter(Boolean)
      const filenames = headLimit === 0 ? matches.slice(offset) : matches.slice(offset, offset + headLimit)
      return {
        pattern,
        path: target,
        numFiles: filenames.length,
        filenames,
        truncated: headLimit === 0 ? false : matches.length - offset > headLimit,
        appliedOffset: offset,
        appliedLimit: headLimit === 0 ? undefined : headLimit,
      }
    },
  },
  {
    name: "Grep",
    aliases: ["grep"],
    permissionTier: "read",
    description: "Search file contents with ripgrep.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
        glob: { type: "string" },
        ignore_case: { type: "boolean" },
        multiline: { type: "boolean" },
        head_limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => typeof input.pattern === "string" && input.pattern.length > 0 ? null : "pattern must be a non-empty string",
    async run(input, context) {
      const pattern = requireString(input, "pattern")
      const target = normalizePathInput(input)
      const absoluteTarget = await resolveWorkspacePath(context.rootDir, context.cwd, target, context, "Grep")
      const relativeTarget = toWorkspaceRelative(context.rootDir, absoluteTarget)
      const outputMode = optionalString(input, "output_mode") ?? "files_with_matches"
      const glob = optionalString(input, "glob")
      const ignoreCase = optionalBoolean(input, "ignore_case") ?? false
      const multiline = optionalBoolean(input, "multiline") ?? false
      const headLimit = optionalNumber(input, "head_limit") ?? DEFAULT_GREP_LIMIT
      const offset = optionalNumber(input, "offset") ?? 0
      const args: string[] = []
      if (ignoreCase) args.push("-i")
      if (multiline) args.push("-U", "--multiline-dotall")
      if (glob) args.push("--glob", glob)
      if (outputMode === "content") {
        const result = await runRg([...args, "-n", pattern, relativeTarget], context.rootDir)
        const lines = result.stdout.split("\n").filter(Boolean)
        const page = headLimit === 0 ? lines.slice(offset) : lines.slice(offset, offset + headLimit)
        return {
          mode: "content",
          content: page.join("\n"),
          numLines: page.length,
          appliedOffset: offset,
          appliedLimit: headLimit === 0 ? undefined : headLimit,
        }
      }
      if (outputMode === "count") {
        const result = await runRg([...args, "-c", pattern, relativeTarget], context.rootDir)
        const lines = result.stdout.split("\n").filter(Boolean)
        const page = headLimit === 0 ? lines.slice(offset) : lines.slice(offset, offset + headLimit)
        return {
          mode: "count",
          numMatches: page.reduce((total, line) => {
            const count = Number(line.split(":").pop() ?? "0")
            return total + (Number.isFinite(count) ? count : 0)
          }, 0),
          filenames: page,
          appliedOffset: offset,
          appliedLimit: headLimit === 0 ? undefined : headLimit,
        }
      }
      const result = await runRg([...args, "-l", pattern, relativeTarget], context.rootDir)
      const matches = result.stdout.split("\n").map(line => line.trim()).filter(Boolean)
      const page = headLimit === 0 ? matches.slice(offset) : matches.slice(offset, offset + headLimit)
      return {
        mode: "files_with_matches",
        numFiles: page.length,
        filenames: page,
        appliedOffset: offset,
        appliedLimit: headLimit === 0 ? undefined : headLimit,
      }
    },
  },
  {
    name: "Bash",
    aliases: ["bash"],
    permissionTier: "edit",
    description: "Execute a shell command locally from the workspace. Optional: run_in_background=true for long-running commands. PROHIBIDO: No uses esta herramienta para invocar APIs externas de LLM o visión (openai, anthropic, client.beta.vision, etc.) desde un script Python o shell. Para análisis visual de imágenes usá la herramienta VisionAnalyze.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number" },
        run_in_background: { type: "boolean" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => typeof input.command === "string" && input.command.trim().length > 0 ? null : "command must be a non-empty string",
    async run(input, context) {
      const command = requireString(input, "command")
      const timeout = optionalNumber(input, "timeout") ?? DEFAULT_BASH_TIMEOUT_MS
      const runInBackground = optionalBoolean(input, "run_in_background") ?? false
      const shell = process.env.SHELL || "/bin/zsh"
      const env = buildTraceEnv(context.traceId)
      const instanceLogPath = context.logger?.logPath
      if (runInBackground) {
        const taskId = randomUUID()
        const paths = ensureDirs(context.rootDir)
        const outputPath = instanceLogPath ?? join(paths.logsDir, `background-${taskId}.log`)
        const stdout = openSync(outputPath, "a")
        const stderr = openSync(outputPath, "a")
        const child = spawn(shell, ["-lc", command], {
          cwd: context.cwd,
          detached: true,
          stdio: ["ignore", stdout, stderr],
          env,
          signal: context.abortSignal,
        })
        child.on("error", () => {})
        child.unref()
        return {
          background: true,
          taskId,
          pid: child.pid,
          outputPath,
          command,
        }
      }
      if (instanceLogPath) {
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        const outputStream = createWriteStream(instanceLogPath, { flags: "a" })
        const child = spawn(shell, ["-lc", command], {
          cwd: context.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env,
          signal: context.abortSignal,
        })
        const timeoutId = setTimeout(() => {
          child.kill("SIGKILL")
        }, timeout)
        child.stdout?.on("data", chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
          stdoutChunks.push(buffer)
          outputStream.write(buffer)
        })
        child.stderr?.on("data", chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
          stderrChunks.push(buffer)
          outputStream.write(buffer)
        })
        const exitCode = await new Promise<number | null>(resolve => {
          child.on("error", () => resolve(null))
          child.on("close", code => resolve(code === null ? null : code))
        })
        clearTimeout(timeoutId)
        outputStream.end()
        return {
          command,
          cwd: context.cwd,
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
          interrupted: exitCode === null,
          exitCode,
        }
      }
      try {
        const result = await execFileAsync(shell, ["-lc", command], {
          cwd: context.cwd,
          timeout,
          maxBuffer: MAX_EXEC_BUFFER,
          env,
          signal: context.abortSignal,
        })
        return {
          command,
          cwd: context.cwd,
          stdout: result.stdout,
          stderr: result.stderr,
          interrupted: false,
          exitCode: 0,
        }
      } catch (error) {
        const typed = error as Error & { code?: number | string; killed?: boolean; stdout?: string; stderr?: string }
        return {
          command,
          cwd: context.cwd,
          stdout: typed.stdout ?? "",
          stderr: typed.stderr ?? typed.message,
          interrupted: typed.killed ?? false,
          exitCode: typeof typed.code === "number" ? typed.code : null,
        }
      }
    },
  },
  {
    name: "ListMcpResourcesTool",
    aliases: ["mcp_list_resources"],
    permissionTier: "read",
    description: "List resources exposed by an MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
      },
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const server = optionalString(input, "server") ?? "demo"
      const client = await getMcpClient(context, server)
      return {
        server,
        resources: await client.listResources(),
      }
    },
  },
  {
    name: "ReadMcpResourceTool",
    aliases: ["mcp_read_resource"],
    permissionTier: "read",
    description: "Read a specific MCP resource by URI.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        uri: { type: "string" },
      },
      required: ["uri"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => typeof input.uri === "string" && input.uri.length > 0 ? null : "uri must be a non-empty string",
    async run(input, context) {
      const server = optionalString(input, "server") ?? "demo"
      const uri = requireString(input, "uri")
      const client = await getMcpClient(context, server)
      return {
        server,
        uri,
        resource: await client.readResource(uri),
      }
    },
  },
  {
    name: "LspQuery",
    permissionTier: "read",
    description: "Query TypeScript semantic information through the workspace LSP server.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["definition", "references", "hover"] },
        file: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
      },
      required: ["action", "file", "line", "character"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.action !== "string" || !["definition", "references", "hover"].includes(input.action)) {
        return "action must be one of: definition, references, hover"
      }
      if (typeof input.file !== "string" || input.file.length === 0) return "file must be a non-empty string"
      if (typeof input.line !== "number" || !Number.isInteger(input.line) || input.line < 0) return "line must be a non-negative integer"
      if (typeof input.character !== "number" || !Number.isInteger(input.character) || input.character < 0) {
        return "character must be a non-negative integer"
      }
      return null
    },
    async run(input, context) {
      const action = requireString(input, "action") as "definition" | "references" | "hover"
      const file = requireString(input, "file")
      const line = input.line as number
      const character = input.character as number
      const absoluteFile = await resolveWorkspacePath(context.rootDir, context.rootDir, file, context, "LspNavigation")
      const relativeFile = toWorkspaceRelative(context.rootDir, absoluteFile)
      const fileUri = pathToFileURL(absoluteFile).href
      const client = await getSharedLspClient(context.rootDir)

      let result: unknown
      switch (action) {
        case "definition":
          result = await client.getDefinition(relativeFile, line, character)
          break
        case "references":
          result = await client.getReferences(relativeFile, line, character)
          break
        case "hover":
          result = await client.getHover(relativeFile, line, character)
          break
      }

      return {
        action,
        file: relativeFile,
        uri: fileUri,
        position: { line, character },
        result,
      }
    },
  },
  {
    name: "WebFetch",
    permissionTier: "read",
    description: "Fetch a URL and extract content relevant to a prompt.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["url", "prompt"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.url !== "string" || !input.url.length) return "url must be a non-empty string"
      try { new URL(input.url) } catch { return "url must be a valid URL" }
      if (typeof input.prompt !== "string") return "prompt must be a string"
      return null
    },
    async run(input, context) {
      const url = requireString(input, "url")
      if (!context.sessionId?.startsWith("agent-") && /\.(jpe?g|png|webp|gif|avif|svg)(\?.*)?$/i.test(url)) {
        return formatToolError("Action denied. Use delegate_background_task instead.")
      }
      const prompt = requireString(input, "prompt")
      const startedAt = Date.now()
      let code = 0
      let codeText = ""
      let contentType = ""
      let bytes = 0
      let content = ""
      try {
        try {
          const response = await fetch(url, {
            headers: {
              "User-Agent": "MonolitoV2/1.0",
              "Accept": "application/json,text/html,application/xhtml+xml,text/plain,*/*",
            },
            signal: AbortSignal.timeout(15000),
          })
          code = response.status
          codeText = response.statusText
          contentType = response.headers.get("content-type") ?? ""
          const buffer = await response.arrayBuffer()
          bytes = buffer.byteLength
          const decoder = new TextDecoder("utf-8", { fatal: false })
          content = decoder.decode(buffer)
        } catch {
          const fallback = await fetchWithCurl(url)
          code = fallback.code
          codeText = fallback.codeText
          bytes = fallback.bytes
          content = fallback.content
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return {
          url,
          prompt,
          error: msg,
          durationMs: Date.now() - startedAt,
        }
      }
      const normalizedContentType = contentType.toLowerCase()
      const trimmedContent = content.trim()
      const looksLikeJson = (trimmedContent.startsWith("{") || trimmedContent.startsWith("["))
      const isJson = /(^|[/+])json\b/.test(normalizedContentType) || (looksLikeJson && isValidJson(trimmedContent))
      if (!isJson) {
        content = /<\/?[a-z][\s\S]*>/i.test(content)
          ? htmlToReadableText(content)
          : content.replace(/\s+/g, " ").trim()
      }
      const maxChars = isJson ? 50_000 : 5_000
      const truncated = isJson
        ? content.length > maxChars ? content.slice(0, maxChars) + "..." : content
        : selectRelevantText(content, prompt, maxChars)
      const relevant = isJson
        ? truncated
        : truncated.toLowerCase().includes(prompt.toLowerCase())
        ? `[Content relevant to "${prompt}"]\n${truncated}`
        : truncated

      if (context.sessionId) {
        try {
          writeSessionSource(
            context.rootDir,
            context.sessionId,
            `WebFetch:${Date.now()}`,
            `Contenido extraído de <${url}> (Prompt: "${prompt}"):\n\n${relevant}`,
            context.profileId,
          )
        } catch (e) {
          // Ignorar errores de guardado en caché
        }
      }

      return {
        url,
        bytes,
        code,
        codeText,
        contentType,
        result: relevant,
        durationMs: Date.now() - startedAt,
      }
    },
  },
  {
    name: "TodoWrite",
    permissionTier: "edit",
    description: "Replace the session task list with the supplied full state. Use this tool proactively for complex multi-step work (3+ steps) so the user can see progress. Input MUST be an object `{ todos: [{ content, activeForm, status: 'pending' | 'in_progress' | 'completed' }] }`. The `todos` key and the `status` field on every item are REQUIRED — omitting them produces a confusing 'requires at least one todo' error. Each todo: `content` (imperative, e.g. 'Run tests'), `activeForm` (present continuous, e.g. 'Running tests'), `status` (one of pending|in_progress|completed). Exactly ONE todo may be in_progress at a time; mark previous ones as completed or pending before promoting a new one. The list is replaced atomically on each call: send the FULL desired state (any todo not in the new list is removed).",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full updated todo list for the session. Existing items not present in this array are removed; new items are created with the supplied content/activeForm/status.",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "Imperative form describing what needs to be done (e.g. 'Run tests', 'Fix authentication bug').",
              },
              activeForm: {
                type: "string",
                description: "Present-continuous form shown during execution (e.g. 'Running tests', 'Fixing authentication bug').",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Status of this todo item. Exactly ONE may be 'in_progress' at a time.",
              },
            },
            required: ["content", "activeForm", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const profileId = context.profileId || "default"
      const sessionId = (context as any).sessionId
      if (!sessionId) {
        return formatToolError("No active session ID found in context.")
      }
      if (!input || typeof input !== "object" || !("todos" in input)) {
        const gotKeys = input && typeof input === "object" ? Object.keys(input).join(", ") : typeof input
        return formatToolError(
          `TodoWrite: input must be an object with a 'todos' array. Got keys: [${gotKeys}]. Expected: {todos: [{content, activeForm, status: 'pending'|'in_progress'|'completed'}]}.`,
        )
      }
      const todos = Array.isArray(input.todos) ? input.todos : []
      if (todos.length === 0) {
        return formatToolError("TodoWrite: todos array is empty. To mark all done, send [{content: 'All previous tasks completed', activeForm: 'Wrapping up', status: 'completed'}] explicitly. To clear the list, call TodoList first to confirm the state.")
      }

      // Validate each todo
      const validStatuses = new Set(["pending", "in_progress", "completed"])
      for (let i = 0; i < todos.length; i++) {
        const t = todos[i] as Record<string, unknown>
        const content = typeof t.content === "string" ? t.content.trim() : ""
        const activeForm = typeof t.activeForm === "string" ? t.activeForm.trim() : ""
        const status = typeof t.status === "string" ? t.status : ""
        if (content.length === 0) {
          return formatToolError(`todos[${i}].content cannot be empty.`)
        }
        if (activeForm.length === 0) {
          return formatToolError(`todos[${i}].activeForm cannot be empty.`)
        }
        if (!validStatuses.has(status)) {
          return formatToolError(`todos[${i}].status must be one of pending|in_progress|completed (got '${status}').`)
        }
      }

      // Structural rule: exactly ONE todo may be in_progress at a time.
      const inProgressCount = todos.filter(t => (t as any).status === "in_progress").length
      if (inProgressCount > 1) {
        return formatToolError(
          `Multiple todos are marked as in_progress (${inProgressCount}). ` +
          `Exactly ONE todo may be in_progress at a time. Mark all but one as 'pending' or 'completed'.`,
        )
      }

      // Atomic replacement: mark all existing tasks in the session as
      // superseded, then write the new ones. This is the entire state, not
      // a diff — the runtime generates fresh ids.
      const now = new Date().toISOString()
      const existing = listSessionTasks(context.rootDir, sessionId, profileId)
      const db = getDb(context.rootDir)
      for (const t of existing) {
        db.prepare(
          `UPDATE palace_nodes SET superseded_at = ? WHERE wing = 'active_tasks' AND room = ? AND node_key = ? AND superseded_at IS NULL`,
        ).run(now, sessionId, t.id)
      }

      const persisted: SessionTask[] = []
      for (const t of todos) {
        const tt = t as { content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }
        const taskId = `task-${randomUUID().slice(0, 8)}`
        const task: SessionTask = {
          id: taskId,
          sessionId,
          content: tt.content,
          activeForm: tt.activeForm,
          status: tt.status,
          createdAt: now,
          updatedAt: now,
        }
        writeSessionTask(context.rootDir, sessionId, taskId, task, profileId)
        persisted.push(task)
      }

      // Verification nudge: if the entire new list is completed, has 3+
      // items, and none mentions a verification step, surface a reminder
      // so the agent adds and executes a verification step before emitting
      // a final summary. Catches the pattern of multi-step work being
      // marked done without any actual verification.
      let verificationNudge: string | undefined
      const allDone = persisted.length > 0 && persisted.every(t => t.status === "completed")
      const hasVerificationStep = persisted.some(t =>
        /\b(verif|test|check|validate|assert|confirm|audit|review|inspect|examine|run\s+tests?|build\s+and|smoke)\b/i.test(t.content),
      )
      if (allDone && persisted.length >= 3 && !hasVerificationStep) {
        verificationNudge =
          "You just closed out 3+ tasks and none of them was a verification step. " +
          "Before writing your final summary, add and execute at least one verification step " +
          "(e.g. 'Run tests', 'Validate output', 'Confirm with tool evidence') and mark it completed. " +
          "You cannot self-assign a passing verdict without a verification step in the todo list."
      }

      const result: Record<string, unknown> = {
        todos: persisted,
        totalInSession: persisted.length,
        profile: profileId,
      }
      if (verificationNudge) result.verificationNudge = verificationNudge
      return result
    },
  },
  {
    name: "system_status",
    aliases: ["SystemStatus"],
    permissionTier: "read",
    description: "Return a concurrent JSON audit of Monolito system health, including JIT-managed services, routing, SQLite sessions, workspace state, and daemon heartbeat timing (lastExecutedAt, lastSkippedAt, isRunning). Use this tool when asked about the current state or recent activity of any daemon component.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run(_input, context) {
      if (!context.runtime?.getSystemStatus) {
        return formatToolError("system_status is unavailable outside the Monolito runtime.")
      }
      return JSON.stringify(await context.runtime.getSystemStatus())
    },
  },
  {
    name: "system_reboot",
    aliases: ["SystemReboot"],
    permissionTier: "edit",
    description: "Reinicia completamente el daemon de Monolito. ÚSALA ÚNICAMENTE después de haber modificado el código fuente y haber verificado que compila (npm run build), para que el sistema cargue tu nueva lógica en memoria.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Motivo del reinicio" },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => typeof input.reason === "string" && input.reason.trim().length > 0 ? null : "reason must be a non-empty string",
    async run(input, context) {
      if (!context.runtime?.gracefulRestart) {
        return formatToolError("system_reboot is unavailable outside the Monolito runtime.")
      }
      const reason = requireString(input, "reason").trim()
      context.runtime.gracefulRestart(reason)
      return `Reinicio iniciado. El sistema volverá a estar online en unos segundos por el motivo: ${reason}`
    },
  },
  {
    name: "SttServiceStatus",
    aliases: ["stt_service_status"],
    permissionTier: "read",
    description: "Show the status of the managed local speech-to-text service container.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run() {
      const config = readChannelsConfig()
      const stt = normalizeSttConfig(config.stt)
      const status = await getManagedSttStatus(stt)
      return {
        managed: stt.managed,
        auto_deploy: stt.autoDeploy,
        auto_transcribe: stt.autoTranscribe,
        status,
        base_url: getManagedSttBaseUrl(stt),
        container_name: stt.containerName,
        image: stt.image,
        port: stt.port,
        engine: stt.engine,
        model: stt.model,
      }
    },
  },
  {
    name: "SttServiceDeploy",
    aliases: ["stt_service_deploy"],
    permissionTier: "edit",
    description: "Deploy or restart the managed local speech-to-text service container using Docker. Cleans conflicting legacy Whisper containers first.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const stt = normalizeSttConfig(config.stt)
      return await deployManagedSttContainer(stt)
    },
  },
  {
    name: "SttServiceStop",
    aliases: ["stt_service_stop"],
    permissionTier: "edit",
    description: "Stop the managed local speech-to-text service container without deleting it.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const stt = normalizeSttConfig(config.stt)
      return await stopManagedSttContainer(stt)
    },
  },
  {
    name: "SttServiceRemove",
    aliases: ["stt_service_remove"],
    permissionTier: "edit",
    description: "Remove the managed local speech-to-text service container and conflicting legacy Whisper containers when found.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const stt = normalizeSttConfig(config.stt)
      return await removeManagedSttContainer(stt)
    },
  },
  {
    name: "SttServiceList",
    aliases: ["stt_service_list"],
    permissionTier: "read",
    description: "List detected local speech-to-text service containers related to the managed image or container name, including legacy Whisper containers.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run() {
      const config = readChannelsConfig()
      const stt = normalizeSttConfig(config.stt)
      return { message: await listManagedSttContainers(stt) }
    },
  },
  {
    name: "TranscribeAudio",
    aliases: ["transcribe_audio"],
    permissionTier: "edit",
    description: "Transcribe a local audio file using the managed speech-to-text backend. Deploys the service automatically when configured.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Local path to the audio file to transcribe." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => typeof input.path === "string" && input.path.length > 0 ? null : "path must be a non-empty string",
    async run(input) {
      const path = requireString(input, "path")
      const config = readChannelsConfig()
      const stt = normalizeSttConfig(config.stt)
      if (stt.managed && stt.autoDeploy) {
        const deploy = await deployManagedSttContainer(stt)
        if (!deploy.ok) return formatToolError(deploy.message)
      }
      const result = await transcribeManagedAudioFile(path, stt)
      if (!result.ok) return formatToolError(result.error ?? "STT transcription failed")
      return result
    },
  },
  {
    name: "TtsServiceStatus",
    aliases: ["tts_service_status"],
    permissionTier: "read",
    description: "Show the status of the managed local TTS service container.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run() {
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      const status = await getManagedTtsStatus(tts)
      return {
        managed: tts.managed,
        auto_deploy: tts.autoDeploy,
        status,
        base_url: getManagedTtsBaseUrl(tts),
        container_name: tts.containerName,
        image: tts.image,
        port: tts.port,
      }
    },
  },
  {
    name: "TtsServiceDeploy",
    aliases: ["tts_service_deploy"],
    permissionTier: "edit",
    description: "Deploy or restart the managed local TTS service container using Docker. Cleans conflicting legacy OpenAI Edge TTS containers first. If this succeeds, GenerateSpeech can use the managed service without a base_url override.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      const result = await deployManagedTtsContainer(tts)
      if (result.ok) {
        writeChannelsConfig({
          ...config,
          tts: {
            ...config.tts,
            managed: true,
            autoDeploy: true,
            baseUrl: result.baseUrl,
            apiKey: tts.apiKey,
            voice: tts.voice,
            model: tts.model,
            responseFormat: tts.responseFormat,
            speed: tts.speed,
            port: tts.port,
            image: tts.image,
            containerName: tts.containerName,
          },
        })
      }
      return result
    },
  },
  {
    name: "TtsServiceStop",
    aliases: ["tts_service_stop"],
    permissionTier: "edit",
    description: "Stop the managed local TTS service container without deleting it.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      return await stopManagedTtsContainer(tts)
    },
  },
  {
    name: "TtsServiceRemove",
    aliases: ["tts_service_remove"],
    permissionTier: "edit",
    description: "Remove the managed local TTS service container. Also removes conflicting legacy OpenAI Edge TTS containers when found.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      return await removeManagedTtsContainer(tts)
    },
  },
  {
    name: "TtsServiceList",
    aliases: ["tts_service_list"],
    permissionTier: "read",
    description: "List detected local TTS service containers related to the managed image or container name, including legacy OpenAI Edge TTS containers such as tts-edge.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run() {
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      return { message: await listManagedTtsContainers(tts) }
    },
  },
  {
    name: "GenerateSpeech",
    aliases: ["generate_speech", "tts_generate"],
    permissionTier: "edit",
    description: "Generate a speech audio file with the configured OpenAI-compatible TTS backend and save it to Monolito scratchpad storage. For Telegram audio requests, call this first, then send the returned local_path with TelegramSendAudio or TelegramSendVoice before claiming the audio was sent.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to synthesize into speech." },
        base_url: { type: "string", description: "Optional TTS base URL override. The tool will call <base_url>/v1/audio/speech." },
        api_key: { type: "string", description: "Optional TTS API key override." },
        voice: { type: "string", description: "Optional voice override, for example es-AR-ElenaNeural." },
        model: { type: "string", description: "Optional TTS model override, for example tts-1." },
        response_format: { type: "string", enum: ["mp3", "opus", "aac", "flac", "wav", "pcm"], description: "Optional audio format override." },
        speed: { type: "number", description: "Optional playback speed override. Typical range 0.25 to 4.0." },
        filename: { type: "string", description: "Optional filename without directory. Saved under Monolito scratchpad." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => {
      if (typeof input.text !== "string" || input.text.trim().length === 0) return "text must be a non-empty string"
      const speed = optionalNumber(input, "speed")
      if (speed !== undefined && (speed <= 0 || speed > 4)) return "speed must be between 0 and 4"
      const format = optionalString(input, "response_format")
      if (format && !TTS_RESPONSE_FORMATS.has(format)) return "response_format must be one of: mp3, opus, aac, flac, wav, pcm"
      return null
    },
    async run(input, context) {
      const text = requireString(input, "text")
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      let baseUrl = (optionalString(input, "base_url") ?? tts.baseUrl).replace(/\/+$/g, "")
      if (tts.managed) {
        baseUrl = getManagedTtsBaseUrl(tts)
        if (tts.autoDeploy) {
          const deploy = await deployManagedTtsContainer(tts)
          if (!deploy.ok) return formatToolError(`TTS managed service unavailable and auto-deploy failed: ${deploy.message}`)
        }
      }
      if (!baseUrl && await getManagedTtsStatus(tts) === "running") {
        baseUrl = getManagedTtsBaseUrl(tts)
      }
      if (!baseUrl) {
        return formatToolError("TTS no está configurado. Usá /config set tts_base_url <url> para configurar una API TTS (como la de MiniMax) o activá managed TTS con /config set tts_managed true.")
      }

      const isTtsApiConfigured = baseUrl.length > 0 && (tts.apiKey || optionalString(input, "api_key"))
      if (!isTtsApiConfigured && !tts.managed) {
        return formatToolError("TTS no está configurado. Usá /config set tts_base_url <url> para configurar una API TTS o habilitá managed TTS.")
      }

      const voice = optionalString(input, "voice") ?? tts.voice
      const model = optionalString(input, "model") ?? tts.model
      const responseFormat = optionalString(input, "response_format") ?? tts.responseFormat
      const speed = optionalNumber(input, "speed") ?? tts.speed
      const apiKey = optionalString(input, "api_key") ?? tts.apiKey
      const paths = ensureDirs(context.rootDir, context.profileId)
      const speechDir = join(paths.scratchpadDir, "tts")
      mkdirSync(speechDir, { recursive: true })

      const extension = inferExtensionFromFormat(responseFormat)
      const requestedFilename = optionalString(input, "filename")
      const filename = requestedFilename
        ? sanitizeFilenameSegment(requestedFilename.replace(/\.[^.]+$/, ""))
        : `${sanitizeFilenameSegment(voice)}-${randomUUID().slice(0, 8)}`
      const localPath = join(speechDir, `${filename}.${extension}`)

      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const response = await fetch(`${baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          input: text,
          voice,
          response_format: responseFormat,
          speed,
        }),
        signal: AbortSignal.timeout(60_000),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => "")
        return formatToolError(`TTS request failed: HTTP ${response.status}${body ? ` - ${body.slice(0, 400)}` : ""}`)
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      writeFileSync(localPath, buffer)

      return {
        ok: true,
        local_path: localPath,
        bytes: buffer.length,
        voice,
        model,
        response_format: responseFormat,
        speed,
      }
    },
  },
  {
    name: "TelegramSend",
    aliases: ["telegram_send"],
    permissionTier: "edit",
    description: "Send a message to a Telegram chat. Requires Telegram to be configured and enabled via /channels.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "The Telegram chat ID to send the message to." },
        text: { type: "string", description: "The text message to send." },
        parse_mode: { type: "string", enum: ["Markdown", "MarkdownV2", "HTML"], description: "Optional parse mode for formatting." },
      },
      required: ["chat_id", "text"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    sideEffect: true,
    validate: input => {
      if (typeof input.chat_id !== "number") return "chat_id must be a number"
      if (typeof input.text !== "string" || input.text.length === 0) return "text must be a non-empty string"
      return null
    },
    async run(input) {
      const chatId = input.chat_id as number
      const text = input.text as string
      const parseMode = optionalString(input, "parse_mode")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        return formatToolError("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const body: Record<string, unknown> = { chat_id: chatId, text }
      if (parseMode) body.parse_mode = parseMode
      const response = await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      const data = await response.json() as { ok: boolean; result?: unknown; description?: string }
      if (!data.ok) {
        return formatToolError(`Telegram API error: ${data.description ?? response.status}`)
      }
      return { ok: true, chat_id: chatId, message: data.result }
    },
  },
  {
    name: "TelegramSendAudio",
    aliases: ["telegram_send_audio"],
    permissionTier: "edit",
    description: "Send an audio file to a Telegram chat. Accepts a Telegram file_id, an HTTP URL, or a local file path. Local files should usually be mp3, m4a, or aac.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "The Telegram chat ID to send the audio to." },
        audio: { type: "string", description: "Telegram file_id, HTTP URL, or local file path." },
        caption: { type: "string", description: "Optional caption for the audio." },
        title: { type: "string", description: "Optional title shown by Telegram." },
        performer: { type: "string", description: "Optional performer shown by Telegram." },
      },
      required: ["chat_id", "audio"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    sideEffect: true,
    validate: input => {
      if (typeof input.chat_id !== "number") return "chat_id must be a number"
      if (typeof input.audio !== "string" || input.audio.length === 0) return "audio must be a non-empty string"
      if (isLocalPath(input.audio) && !TELEGRAM_AUDIO_FORMATS.has((input.audio.split(".").pop() ?? "").toLowerCase())) {
        return "local audio files should use mp3, m4a, or aac"
      }
      return null
    },
    async run(input) {
      const chatId = input.chat_id as number
      const audio = requireString(input, "audio")
      const caption = optionalString(input, "caption")
      const title = optionalString(input, "title")
      const performer = optionalString(input, "performer")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        return formatToolError("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const params: Record<string, unknown> = { chat_id: chatId, audio }
      if (caption) params.caption = caption
      if (title) params.title = title
      if (performer) params.performer = performer
      const data = isLocalPath(audio)
        ? await telegramApiCallWithFile(config.telegram.token, "sendAudio", "audio", audio, params)
        : await telegramApiCall(config.telegram.token, "sendAudio", params)
      if (!data.ok) return formatToolError(`Telegram API error: ${data.description ?? "sendAudio failed"}`)
      return { ok: true, chat_id: chatId, message: data.result }
    },
  },
  {
    name: "TelegramSendVoice",
    aliases: ["telegram_send_voice"],
    permissionTier: "edit",
    description: "Send a voice note to a Telegram chat. Accepts a Telegram file_id, an HTTP URL, or a local file path. Local files should usually be ogg or opus.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "The Telegram chat ID to send the voice note to." },
        voice: { type: "string", description: "Telegram file_id, HTTP URL, or local file path." },
        caption: { type: "string", description: "Optional caption for the voice note." },
      },
      required: ["chat_id", "voice"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    sideEffect: true,
    validate: input => {
      if (typeof input.chat_id !== "number") return "chat_id must be a number"
      if (typeof input.voice !== "string" || input.voice.length === 0) return "voice must be a non-empty string"
      if (isLocalPath(input.voice) && !TELEGRAM_VOICE_FORMATS.has((input.voice.split(".").pop() ?? "").toLowerCase())) {
        return "local voice files should use ogg or opus"
      }
      return null
    },
    async run(input) {
      const chatId = input.chat_id as number
      const voice = requireString(input, "voice")
      const caption = optionalString(input, "caption")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        return formatToolError("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const params: Record<string, unknown> = { chat_id: chatId, voice }
      if (caption) params.caption = caption
      const data = isLocalPath(voice)
        ? await telegramApiCallWithFile(config.telegram.token, "sendVoice", "voice", voice, params)
        : await telegramApiCall(config.telegram.token, "sendVoice", params)
      if (!data.ok) return formatToolError(`Telegram API error: ${data.description ?? "sendVoice failed"}`)
      return { ok: true, chat_id: chatId, message: data.result }
    },
  },
  {
    name: "TelegramSendPhoto",
    permissionTier: "edit",
    description: "Send a photo to a Telegram chat. Accepts a Telegram file_id, an HTTP URL, or a local file path.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "The Telegram chat ID to send the photo to." },
        photo: { type: "string", description: "Telegram file_id, HTTP URL, or local file path." },
        caption: { type: "string", description: "Optional caption for the photo." },
        parse_mode: { type: "string", enum: ["Markdown", "MarkdownV2", "HTML"], description: "Optional parse mode for the caption." },
        ignore_cache: { type: "boolean", description: "Set to true to ignore send cache and force sending even if sent before." },
      },
      required: ["chat_id", "photo"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    sideEffect: true,
    validate: input => {
      if (typeof input.chat_id !== "number") return "chat_id must be a number"
      if (typeof input.photo !== "string" || input.photo.length === 0) return "photo must be a non-empty string"
      if (input.ignore_cache !== undefined && typeof input.ignore_cache !== "boolean") return "ignore_cache must be a boolean"
      return null
    },
    async run(input, context) {
      const chatId = input.chat_id as number
      const photo = requireString(input, "photo")
      const caption = optionalString(input, "caption")
      const parseMode = optionalString(input, "parse_mode")
      const ignoreCache = input.ignore_cache === true
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        return formatToolError("Telegram is not configured or not enabled. Use /channels to set it up.")
      }

      if (isLocalPath(photo)) {
        const resolvedPath = resolveMonolitoPath(photo)
        if (!ignoreCache && isPhotoAlreadySent(context.rootDir, resolvedPath)) {
          return { ok: true, chat_id: chatId, message: "Photo already sent previously (deduplicated)", deduplicated: true }
        }
        const params: Record<string, unknown> = { chat_id: chatId, photo }
        if (caption) params.caption = caption
        if (parseMode) params.parse_mode = parseMode
        const data = await telegramApiCallWithFile(config.telegram.token, "sendPhoto", "photo", photo, params)
        if (data.ok) markPhotoAsSent(context.rootDir, resolvedPath)
        if (!data.ok) return formatToolError(`Telegram API error: ${data.description ?? "sendPhoto failed"}`)
        return { ok: true, chat_id: chatId, message: data.result }
      }

      const params: Record<string, unknown> = { chat_id: chatId, photo }
      if (caption) params.caption = caption
      if (parseMode) params.parse_mode = parseMode
      const data = await telegramApiCall(config.telegram.token, "sendPhoto", params)
      if (!data.ok) return formatToolError(`Telegram API error: ${data.description ?? "sendPhoto failed"}`)
      return { ok: true, chat_id: chatId, message: data.result }
    },
  },
  {
    name: "TelegramSendDocument",
    permissionTier: "edit",
    description: "Send a document to a Telegram chat. Accepts a Telegram file_id, an HTTP URL, or a local file path.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "The Telegram chat ID to send the document to." },
        document: { type: "string", description: "Telegram file_id, HTTP URL, or local file path." },
        caption: { type: "string", description: "Optional caption for the document." },
      },
      required: ["chat_id", "document"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    sideEffect: true,
    validate: input => {
      if (typeof input.chat_id !== "number") return "chat_id must be a number"
      if (typeof input.document !== "string" || input.document.length === 0) return "document must be a non-empty string"
      return null
    },
    async run(input) {
      const chatId = input.chat_id as number
      const document = requireString(input, "document")
      const caption = optionalString(input, "caption")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        return formatToolError("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const params: Record<string, unknown> = { chat_id: chatId, document }
      if (caption) params.caption = caption
      const data = isLocalPath(document)
        ? await telegramApiCallWithFile(config.telegram.token, "sendDocument", "document", document, params)
        : await telegramApiCall(config.telegram.token, "sendDocument", params)
      if (!data.ok) return formatToolError(`Telegram API error: ${data.description ?? "sendDocument failed"}`)
      return { ok: true, chat_id: chatId, message: data.result }
    },
  },
  {
    name: "TelegramGetFile",
    permissionTier: "read",
    description: "Resolve a Telegram file_id into Telegram file metadata and a downloadable file_path.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The Telegram file_id to inspect." },
      },
      required: ["file_id"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => typeof input.file_id === "string" && input.file_id.length > 0 ? null : "file_id must be a non-empty string",
    async run(input) {
      const fileId = requireString(input, "file_id")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        return formatToolError("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const data = await telegramApiCall(config.telegram.token, "getFile", { file_id: fileId })
      if (!data.ok) return formatToolError(`Telegram API error: ${data.description ?? "getFile failed"}`)
      return { ok: true, file: data.result }
    },
  },
  {
    name: "DownloadFile",
    permissionTier: "read",
    description: "Download any file from a public HTTP/HTTPS URL into the secure Monolito scratchpad storage and return the local path. Essential for bypassing hotlinking blocks on images or getting documents.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The HTTP/HTTPS URL of the file to download." },
        filename: { type: "string", description: "Optional local filename override (including extension). If not provided, a safe name will be generated from the URL path." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.url !== "string" || input.url.length === 0) return "url must be a non-empty string"
      try { new URL(input.url) } catch { return "url must be a valid HTTP/HTTPS URL" }
      if (input.filename !== undefined && typeof input.filename !== "string") return "filename must be a string"
      return null
    },
    async run(input, context) {
      const url = requireString(input, "url")
      const filename = optionalString(input, "filename")
      
      const paths = ensureDirs(context.rootDir)
      const downloadsDir = join(paths.scratchpadDir, "downloads")
      
      const startedAt = Date.now()
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "*/*",
          },
          signal: AbortSignal.timeout(30_000),
        })
        
        if (!response.ok) {
          throw new Error(`HTTP Error ${response.status}: ${response.statusText}`)
        }
        
        const contentType = response.headers.get("content-type") ?? "application/octet-stream"
        const buffer = Buffer.from(await response.arrayBuffer())
        
        // Determinar nombre del archivo
        let finalName = filename
        if (!finalName) {
          const parsedUrl = new URL(url)
          const urlSegment = parsedUrl.pathname.split("/").at(-1)
          finalName = urlSegment && urlSegment.includes(".")
            ? sanitizeFilenameSegment(urlSegment)
            : `download-${Date.now()}`
        }
        
        // Asegurar extensión adecuada si falta en la inferencia básica
        if (!finalName.includes(".") && contentType !== "application/octet-stream") {
          const mimeExt = contentType.split(";")[0]?.split("/")[1]
          if (mimeExt) finalName = `${finalName}.${mimeExt}`
        }
        
        mkdirSync(downloadsDir, { recursive: true })
        const localPath = join(downloadsDir, finalName)
        writeFileSync(localPath, buffer)
        
        return {
          ok: true,
          url,
          local_path: localPath,
          bytes: buffer.length,
          content_type: contentType,
          durationMs: Date.now() - startedAt,
        }
      } catch (error: any) {
        return formatToolError(`Download failed: ${error.message || error}`)
      }
    },
  },
  {
    name: "TelegramDownloadFile",
    permissionTier: "edit",
    description: "Download a Telegram file_id into Monolito scratchpad storage and return the local path. IMPORTANT: Do NOT execute this tool for standard attachments that already provide a 'local_path' attribute, as they are downloaded automatically. Only execute this tool as a manual override when a Telegram attachment exceeds the auto-download size limit (status='size_limit_exceeded') and the user explicitly confirms they want to proceed.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The Telegram file_id to download." },
        filename: { type: "string", description: "Optional local filename override." },
      },
      required: ["file_id"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => typeof input.file_id === "string" && input.file_id.length > 0 ? null : "file_id must be a non-empty string",
    async run(input, context) {
      const fileId = requireString(input, "file_id")
      const filename = optionalString(input, "filename")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        return formatToolError("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      return await resolveTelegramDownload(config.telegram.token, fileId, context.rootDir, filename)
    },
  },
  {
    name: "TodoList",
    permissionTier: "read",
    description: "List tasks for the current agent profile and session.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["all", "pending", "in_progress", "completed"] },
      },
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const filter = optionalString(input, "filter") ?? "all"
      const profileId = context.profileId || "default"
      const sessionId = (context as any).sessionId
      if (!sessionId) {
        return formatToolError("No active session ID found in context.")
      }

      const tasks = listSessionTasks(context.rootDir, sessionId, profileId)
      const filtered = filter === "all" ? tasks : tasks.filter(t => t.status === filter)

      return {
        tasks: filtered,
        totalInSession: tasks.length,
        filter,
        profile: profileId
      }
    },
  },
  {
    name: "BootRead",
    permissionTier: "read",
    description: "Read a deterministic or dynamically created BOOT wing from SQLite without relying on legacy workspace files.",
    inputSchema: {
      type: "object",
      properties: {
        wing: { type: "string" },
      },
      required: ["wing"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      try {
        const wing = requireString(input, "wing")
        ensureBootWings(context.rootDir, context.profileId ?? "default")
        if (!bootWingExists(context.rootDir, wing, context.profileId ?? "default")) {
          return formatToolError(`BOOT wing ${wing} not found in profile ${context.profileId ?? "default"}. Use BootListWings to inspect available wings.`)
        }
        const content = readBootWing(context.rootDir, wing, context.profileId ?? "default")
        if (content == null) return formatToolError(`BOOT wing ${wing} not found in profile ${context.profileId ?? "default"}`)
        return { wing, content, profile: context.profileId ?? "default" }
      } catch (error) {
        return formatToolError(error)
      }
    },
  },
  {
    name: "BootListWings",
    permissionTier: "read",
    description: "List BOOT wings currently registered in SQLite for the active profile. Run this before BootCreateWing or BootWrite when choosing a wing.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run(_input, context) {
      try {
        const profile = context.profileId ?? "default"
        const wings = listBootWings(context.rootDir, profile)
        return JSON.stringify({ profile, wings })
      } catch (error) {
        return formatToolError(error)
      }
    },
  },
  {
    name: "BootCreateWing",
    permissionTier: "edit",
    description: "Create a new empty BOOT wing in SQLite for the active profile. The model MUST call BootListWings first and only use this when the desired alphanumeric/snake_case wing is absent.",
    inputSchema: {
      type: "object",
      properties: {
        wing: {
          type: "string",
          description: "New BOOT wing name. Use alphanumeric/snake_case only, starting with a letter.",
          pattern: "^[A-Za-z][A-Za-z0-9_]*$",
        },
      },
      required: ["wing"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => validateZod(bootCreateWingInputZod, input),
    async run(input, context) {
      try {
        const parsed = parseZod(bootCreateWingInputZod, input, "BootCreateWing input")
        const wing = parsed.wing.trim()
        if (!isBootWingName(wing)) {
          return formatToolError(
            `Cannot create custom BOOT wing "${wing}". Only standard wings are allowed: ${BOOT_WING_ORDER.join(", ")}. ` +
            `For custom episodic data, use WorkspaceMemoryFiling instead.`
          )
        }
        const profile = context.profileId ?? "default"
        if (bootWingExists(context.rootDir, wing, profile)) {
          return formatToolError(`BOOT wing ${wing} already exists in profile ${profile}. Use BootWrite to update it.`)
        }
        const result = createBootWing(context.rootDir, wing, profile, "")
        return { ok: true, wing, created: result.created, profile }
      } catch (error) {
        return formatToolError(error)
      }
    },
  },
  {
    name: "BootWrite",
    permissionTier: "edit",
    description: "Replace or append to the content of an existing BOOT wing in SQLite. Use BootListWings first; if the wing does not exist, create it with BootCreateWing before writing. WARNING: Use ONLY for core, permanent identity rules. For episodic memories, temporary data, or conversational facts, use WorkspaceMemoryFiling instead.",
    inputSchema: {
      type: "object",
      properties: {
        wing: { type: "string" },
        content: { type: "string" },
        action: { type: "string", enum: ["overwrite", "append"], description: "Action to perform. Default is 'overwrite'." },
      },
      required: ["wing", "content"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => validateZod(bootWriteInputZod, input),
    async run(input, context) {
      try {
        const parsed = parseZod(bootWriteInputZod, input, "BootWrite input")
        const wing = parsed.wing
        const profileId = context.profileId ?? "default"
        if (!bootWingExists(context.rootDir, wing, profileId)) {
          return formatToolError(`BOOT wing ${wing} does not exist in profile ${profileId}. Use BootListWings, then BootCreateWing if you need a new wing.`)
        }
        const append = parsed.action === "append"
        const result = writeBootWing(context.rootDir, wing, parsed.content, profileId, append)
        return { wing, ok: true, changed: result.changed, bytes: result.bytes, profile: profileId }
      } catch (error) {
        return formatToolError(error)
      }
    },
  },
  {
    name: "WorkspaceMemoryFiling",
    permissionTier: "edit",
    description: "Store facts, decisions, or snippets in the SQLite Memory Palace. Use wing='SHARED' for team-wide memory visible to every profile. Use wing='session_preferences' with room=sessionId and key='pref_silent_research' (content='true'/'false') to dynamically toggle silent background updates for this session.",
    inputSchema: {
      type: "object",
      properties: {
        wing: { type: "string", description: "Wing name. Use 'SHARED' for global memory, or 'session_preferences' to toggle session-scoped preferences (with room=sessionId)." },
        room: { type: "string", description: "Topical room within the wing (e.g. 'architecture', 'auth')." },
        key: { type: "string", description: "Optional stable key to group or retrieve a specific memory later." },
        content: { type: "string", description: "The raw verbatim detail or decision to save." },
      },
      required: ["wing", "room", "content"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    async run(input, context) {
      const wing = requireString(input, "wing")
      const room = requireString(input, "room")
      const key = optionalString(input, "key")
      const content = requireString(input, "content")
      const id = await fileMemory(context.rootDir, wing, room, content, context.profileId, key)
      return { ok: true, id, wing, room, key: key ?? null, shared: wing.trim().toUpperCase() === "SHARED" }
    },
  },
  {
    name: "WorkspaceMemoryRecall",
    permissionTier: "read",
    description: "Recall memories from the SQLite Memory Palace. Results are limited to the current profile plus global SHARED memories. Calls without filters still respect that isolation.",
    inputSchema: {
      type: "object",
      properties: {
        wing: { type: "string", description: "Optional filter for a specific wing." },
        room: { type: "string", description: "Optional filter for a specific room to narrow down." },
        key: { type: "string", description: "Optional stable key filter for an exact memory group." },
        query: { type: "string", description: "Optional natural language query for deep semantic search." }
      },
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const wing = optionalString(input, "wing")
      const room = optionalString(input, "room")
      const key = optionalString(input, "key")
      const query = optionalString(input, "query")

      let results: any[] = []
      let warning: string | null = null
      let semanticSearchActive = !!query
      try {
        results = await recallMemory(context.rootDir, wing, room, query, context.profileId, key)
      } catch (error) {
        if (!query || !isEmbeddingsUnavailableError(error)) return formatToolError(error)
        semanticSearchActive = false
        warning = "La memoria semántica no está disponible en este momento; muestro memoria básica reciente."
        results = await recallMemory(context.rootDir, wing, room, undefined, context.profileId, key)
      }
      
      if (!wing && !room && !key && !query) {
        return {
          wings: listWings(context.rootDir, context.profileId),
          recentMemories: results,
          warning,
        }
      }
      if (wing && !room && !key && !query) {
        return {
          wing,
          rooms: listRooms(context.rootDir, wing, context.profileId),
          memories: results,
          warning,
        }
      }
      return {
        wing,
        room,
        key,
        query,
        semanticSearchActive,
        warning,
        memories: results
      }
    },
  },
  {
    name: "KgAdd",
    permissionTier: "edit",
    description: "Add a temporal knowledge-graph triple scoped to the current profile.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Entity or subject node." },
        predicate: { type: "string", description: "Relationship label." },
        object: { type: "string", description: "Entity, value, or object node." },
        valid_from: { type: "string", description: "Optional ISO timestamp for when the fact became valid." },
      },
      required: ["subject", "predicate", "object"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    async run(input, context) {
      const subject = requireString(input, "subject")
      const predicate = requireString(input, "predicate")
      const object = requireString(input, "object")
      const validFrom = optionalString(input, "valid_from") ?? new Date().toISOString()
      const profileId = context.profileId ?? "default"
      const id = addGraphTriple(context.rootDir, profileId, subject, predicate, object, validFrom)
      return { ok: true, id, profileId, subject, predicate, object, valid_from: validFrom, active: true }
    },
  },
  {
    name: "KgInvalidate",
    permissionTier: "edit",
    description: "Invalidate an active temporal knowledge-graph triple by setting valid_to.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Entity or subject node." },
        predicate: { type: "string", description: "Relationship label." },
        object: { type: "string", description: "Entity, value, or object node." },
        valid_to: { type: "string", description: "Optional ISO timestamp for when the fact stopped being valid." },
      },
      required: ["subject", "predicate", "object"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    async run(input, context) {
      const subject = requireString(input, "subject")
      const predicate = requireString(input, "predicate")
      const object = requireString(input, "object")
      const validTo = optionalString(input, "valid_to") ?? new Date().toISOString()
      const profileId = context.profileId ?? "default"
      const result = invalidateGraphTriple(context.rootDir, profileId, subject, predicate, object, validTo)
      return {
        ok: result.changes > 0,
        profileId,
        subject,
        predicate,
        object,
        valid_to: validTo,
        invalidated: result.changes,
      }
    },
  },
  {
    name: "KgQuery",
    permissionTier: "read",
    description: "Query temporal knowledge-graph facts for an entity within the current profile.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Entity to search as subject or object." },
      },
      required: ["entity"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const entity = requireString(input, "entity")
      const profileId = context.profileId ?? "default"
      const facts = queryGraphEntity(context.rootDir, profileId, entity)
      return {
        ok: true,
        profileId,
        entity,
        facts,
      }
    },
  },
  {
    name: "SessionForensics",
    permissionTier: "read",
    description: "Inspect persisted session evidence before answering questions about what happened, what was said, which tools/workers ran, or where a prior conclusion came from. This is ALSO the correct tool for questions about internal daemon events such as heartbeat history, memory consolidation runs, background turns, and worklog entries — use this instead of Bash/Grep over source code.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Optional session ID. Defaults to the current session, otherwise the latest session for the active profile." },
        intent: { type: "string", enum: ["auto", "history", "actions", "delegation", "origin"], description: "What kind of reconstruction you need." },
        question: { type: "string", description: "Optional natural language cue to help auto-select the right evidence." },
        messageLimit: { type: "number", description: "How many recent messages to inspect. Default 6." },
        worklogLimit: { type: "number", description: "How many recent worklog entries to inspect. Default 8." },
        eventLimit: { type: "number", description: "How many recent runtime events to inspect. Default 12." },
      },
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const requestedSessionId = optionalString(input, "sessionId") ?? context.sessionId
      const requestedIntent = resolveForensicsIntent(optionalString(input, "intent"))
      const question = optionalString(input, "question")

      // Ampliación de límites máximos para SessionForensics
      const messageLimit = Math.max(1, Math.min(40, optionalNumber(input, "messageLimit") ?? 6))
      const worklogLimit = Math.max(1, Math.min(60, optionalNumber(input, "worklogLimit") ?? 8))
      const eventLimit = Math.max(1, Math.min(80, optionalNumber(input, "eventLimit") ?? 12))

      const session = pickForensicsSession(context.rootDir, context.profileId, requestedSessionId)

      // Extracción de palabras clave significativas (min. 3 caracteres)
      const searchTerms = question
        ? Array.from(new Set(question
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .match(/[a-z0-9]{3,}/g) ?? []))
            .filter(term => !["para", "por", "con", "una", "uno", "unos", "unas", "del", "las", "los", "the", "and", "for", "from", "that", "this", "sobre", "como", "cual", "que", "est", "este", "esta", "sus"].includes(term))
        : []

      let events: ReturnType<typeof tailEvents>
      let recentMessages: typeof session.messages
      let recentWorklog: typeof session.worklog

      if (searchTerms.length > 0) {
        // Filtrar todos los mensajes
        const matchedMsgs = session.messages.filter(m => {
          const textNorm = m.text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
          return searchTerms.some(term => textNorm.includes(term))
        })
        recentMessages = matchedMsgs.length > 0 ? matchedMsgs.slice(-messageLimit) : session.messages.slice(-messageLimit)

        // Filtrar todos los worklogs
        const matchedLogs = session.worklog.filter(l => {
          const sumNorm = l.summary.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
          return searchTerms.some(term => sumNorm.includes(term))
        })
        recentWorklog = matchedLogs.length > 0 ? matchedLogs.slice(-worklogLimit) : session.worklog.slice(-worklogLimit)

        // Filtrar eventos de un pool más amplio (100 eventos)
        const allEvents = tailEvents(context.rootDir, session.id, 100)
        const matchedEvts = allEvents.filter(e => {
          const evtStr = JSON.stringify(e).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
          return searchTerms.some(term => evtStr.includes(term))
        })
        events = matchedEvts.length > 0 ? matchedEvts.slice(-eventLimit) : allEvents.slice(-eventLimit)
      } else {
        events = tailEvents(context.rootDir, session.id, eventLimit)
        recentMessages = session.messages.slice(-messageLimit)
        recentWorklog = session.worklog.slice(-worklogLimit)
      }

      const effectiveIntent = requestedIntent === "auto" ? inferForensicsIntent(question) : requestedIntent

      const messageLines = recentMessages.map(message => `${message.at} ${message.role}: ${truncateText(message.text, 220)}`)
      const worklogLines = recentWorklog.map(entry => `${entry.at} [${entry.type}] ${truncateText(entry.summary, 220)}`)
      const eventLines = events.map(event => buildEventLine(event as Record<string, unknown>))

      const delegationEvidence = uniqueLines([
        ...events
          .filter(event => event.type === "agent.background.completed")
          .map(event => buildEventLine(event as Record<string, unknown>)),
        ...events
          .filter(event => event.type === "tool.start" || event.type === "tool.finish")
          .filter(event => {
            const tool = typeof (event as { tool?: unknown }).tool === "string" ? String((event as { tool?: unknown }).tool) : ""
            return ["AgentSpawn", "delegate_background_task", "list_active_workers", "AgentSendMessage"].includes(tool)
          })
          .map(event => buildEventLine(event as Record<string, unknown>)),
        ...recentWorklog
          .map(entry => entry.summary)
          .filter(summary => /\b(worker|workers|agent|agente|delegat|spawn|background)\b/i.test(summary)),
      ])

      let summary = ""
      let evidence: string[] = []
      let recommendedSources: string[] = []

      switch (effectiveIntent) {
        case "history":
          summary = "Usá los mensajes persistidos como fuente principal para reconstruir quién dijo qué."
          evidence = messageLines
          recommendedSources = ["messages", "worklog"]
          break
        case "delegation":
          summary = delegationEvidence.length > 0
            ? "Encontré evidencia operativa de delegación/workers en los eventos y/o worklog de la sesión."
            : "No encontré evidencia operativa de delegación/workers en los eventos recientes de la sesión."
          evidence = delegationEvidence.length > 0 ? delegationEvidence : [...eventLines, ...worklogLines].slice(-8)
          recommendedSources = ["events", "worklog", "messages"]
          break
        case "origin": {
          const lastUser = recentMessages.filter(message => message.role === "user").at(-1)
          const lastAssistant = recentMessages.filter(message => message.role === "assistant").at(-1)
          const originEvidence = uniqueLines([
            lastUser ? `Last user message: ${truncateText(lastUser.text, 220)}` : "",
            lastAssistant ? `Last assistant message: ${truncateText(lastAssistant.text, 220)}` : "",
            ...eventLines.filter(line => /tool\.finish|agent\.background\.completed|error/.test(line)),
            ...worklogLines.filter(line => /\b(Tool|Assistant:|Memory agent:|Turn completed|Turn started)\b/.test(line)),
          ])
          summary = "Reconstruí el origen probable desde el último intercambio y la evidencia operativa reciente."
          evidence = originEvidence.slice(0, 10)
          recommendedSources = ["messages", "events", "worklog"]
          break
        }
        case "actions":
        default:
          summary = "Usá worklog y eventos como fuente principal para explicar qué hizo el runtime en esta sesión."
          evidence = uniqueLines([...worklogLines, ...eventLines]).slice(-12)
          recommendedSources = ["worklog", "events", "messages"]
          break
      }

      return {
        ok: true,
        session: {
          id: session.id,
          title: session.title,
          state: session.state,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
        intent: effectiveIntent,
        question: question ?? null,
        summary,
        recommendedSources,
        evidence,
        counts: {
          messagesInspected: recentMessages.length,
          worklogInspected: recentWorklog.length,
          eventsInspected: events.length,
        },
        nextStepHint: "If this is still insufficient, inspect raw logs only for runtime/daemon discrepancies rather than conversational history.",
      }
    },
  },
  {
    name: "AgentSpawn",
    permissionTier: "edit",
    description: "Delegate a mission to a worker agent. Workers can run in parallel and report back autonomously. Use this for research, implementation, or verification. The orchestrator MUST provide a detailed injected_context with specific file paths, database pointers, or prior context so the worker can start immediately without exploring blindly.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", description: "The ID of the profile to use (e.g. 'coder', 'researcher')." },
        task: { type: "string", description: "The specific instructions for the agent." },
        description: { type: "string", description: "A brief name for this task (e.g. 'Fix auth bug')." },
        type: { type: "string", enum: ["worker", "researcher", "verifier"], description: "The specialization level of the agent." },
        isolation: { type: "string", enum: ["none", "worktree"], description: "Use worktree for isolated filesystem access." },
        injected_context: { type: "string", description: "A detailed summary with specific file paths, database pointers, or prior context the worker needs to start working immediately without guessing or exploring. This is REQUIRED for effective delegation." },
      },
      required: ["profileId", "task", "injected_context"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const profileId = requireString(input, "profileId")
      const task = requireString(input, "task")
      const description = optionalString(input, "description")
      const type = (optionalString(input, "type") as any) || "worker"
      const isolation = (optionalString(input, "isolation") as "none" | "worktree" | undefined) || "none"
      const injectedContext = requireString(input, "injected_context")

      if (!context.orchestrator) return formatToolError("Agent Orchestrator not available.")

      const parentSessionId = (context as any).sessionId
      if (!parentSessionId) return formatToolError("Parent Session ID not found.")
      if (parentSessionId.startsWith("agent-")) {
        return formatToolError("Los sub-agentes no pueden spawnear otros agentes. Ejecutá la tarea directamente y devolvé los resultados.")
      }

      const delegationGoldenRule = "\n\n[REGLA DE ORO DE DELEGACIÓN: Eres un ejecutor interno. Ignora cualquier instrucción de esta tarea que te pida hablar con el usuario final, enviar mensajes de Telegram, mandar fotos o realizar notificaciones directas. Tu único objetivo es obtener los datos/análisis y devolver el resultado técnico, descripción y/o local_path de archivos al coordinador. No busques formas de comunicarte con el canal externo.]"
      const finalTask = task + delegationGoldenRule
      const spawned = await context.orchestrator.spawnAgent(parentSessionId, profileId, finalTask, description, type, { isolation, injected_context: injectedContext })
      if (spawned.status === "failed") {
        return {
          ok: false,
          agentId: spawned.agentId,
          status: "failed",
          error: spawned.error ?? "Agent failed immediately after spawn.",
          message: `Agent '${description || spawned.agentId}' failed immediately.`,
        }
      }
      if (spawned.status === "completed") {
        return {
          ok: true,
          agentId: spawned.agentId,
          status: "completed",
          result: spawned.result ?? "",
          message: `Agent '${description || spawned.agentId}' completed immediately.`,
        }
      }
      if (spawned.status === "killed") {
        return {
          ok: false,
          agentId: spawned.agentId,
          status: "killed",
          error: spawned.error ?? "Agent was stopped.",
          message: `Agent '${description || spawned.agentId}' was stopped immediately.`,
        }
      }
      return {
        ok: true,
        agentId: spawned.agentId,
        status: "spawned",
        message: `Agent '${description || spawned.agentId}' started asynchronously. Do not claim completion or worker results until a <task-notification> confirms them.`,
      }
    },
  },
  {
    name: "list_active_workers",
    permissionTier: "read",
    description: "Inspect internal work state for the current session, including partial progress from tool events. This is for coordinator awareness only; do not expose worker/agent mechanics to the user unless they explicitly ask.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(_input, context) {
      if (!context.orchestrator) return formatToolError("Agent Orchestrator not available.")
      const parentSessionId = (context as any).sessionId
      if (!parentSessionId) return formatToolError("Parent Session ID not found.")
      return {
        ok: true,
        internal_tasks: context.orchestrator.getTaskSnapshot(parentSessionId),
      }
    },
  },
  {
    name: "delegate_background_task",
    permissionTier: "edit",
    description: "Start internal asynchronous work for high cognitive load tasks (multiple web searches, deep reading, long analysis, multi-step research) to avoid blocking the chat. The internal executor reports back to the coordinator; it must not speak to the user. After calling this tool, acknowledge as your own ongoing action (for example: 'Me pongo con eso, dame un momento') and do not mention workers, agents, delegation, or background tasks unless the user explicitly asks how the work is coordinated. IMPORTANT: Only the primary coordinator may call this tool. Sub-agents must NEVER call delegate_background_task — they must execute their task directly and return results. For image requests, delegate only when the user explicitly asks to verify/analyze/describe visual content or when the task is otherwise long-running. Simple image search/delivery should use ImageSearch directly.",
    inputSchema: {
      type: "object",
      properties: {
        task_instruction: { type: "string", description: "Detailed instructions for the background worker." },
        description: { type: "string", description: "Short label for this task." },
        profileId: { type: "string", description: "Optional profile to run the worker under." },
        injected_context: { type: "string", description: "A detailed summary with specific file paths, database pointers, or prior context the worker needs to start working immediately without guessing or exploring. This is REQUIRED for effective delegation." },
      },
      required: ["task_instruction", "injected_context"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const task = requireString(input, "task_instruction")
      const injectedContext = requireString(input, "injected_context")
      const description = optionalString(input, "description")
      const profileId = optionalString(input, "profileId") ?? context.profileId ?? "default"

      if (!context.orchestrator) return formatToolError("Agent Orchestrator not available.")
      const parentSessionId = (context as any).sessionId
      if (!parentSessionId) return formatToolError("Parent Session ID not found.")
      if (parentSessionId.startsWith("agent-")) {
        return formatToolError("Los sub-agentes no pueden delegar tareas en background. Ejecutá la tarea directamente y devolvé los resultados.")
      }
      const activeWorkers = context.orchestrator
        .getTaskSnapshot(parentSessionId)
        .filter(worker => worker.status === "pending" || worker.status === "running")
      if (activeWorkers.length >= 4) {
        return {
          ok: false,
          error: "Ya hay 4 workers activos para esta sesión. Esperá alguna <task-notification> antes de delegar más.",
        }
      }

      const latestUserText = parentSessionId.startsWith("telegram-")
        ? latestActionableUserText(context.rootDir, parentSessionId)
        : ""
      const effectiveTask = parentSessionId.startsWith("telegram-") &&
        isImageIntentText(task) &&
        isTelegramPhotoDeliveryRequest(latestUserText)
        ? buildTelegramPhotoWorkerTask(task, parentSessionId, latestUserText)
        : task

      const delegationGoldenRule = "\n\n[REGLA DE ORO DE DELEGACIÓN: Eres un ejecutor interno. Ignora cualquier instrucción de esta tarea que te pida hablar con el usuario final, enviar mensajes de Telegram, mandar fotos o realizar notificaciones directas. Tu único objetivo es obtener los datos/análisis y devolver el resultado técnico, descripción y/o local_path de archivos al coordinador. No busques formas de comunicarte con el canal externo.]"
      const finalTask = effectiveTask + delegationGoldenRule
      const jobGroupId = context.runtime?.acquireJobGroupForBatch(parentSessionId)
      const spawned = await context.orchestrator.spawnBackgroundTask(parentSessionId, profileId, finalTask, description, jobGroupId, { injected_context: injectedContext })
      return {
        ok: spawned.status !== "failed" && spawned.status !== "killed",
        job_id: spawned.agentId,
        status: spawned.status,
        result: spawned.result ?? "",
        error: spawned.error,
        message: spawned.status === "spawned"
          ? "Internal task started. Do not mention internal workers or agents to the user unless explicitly asked."
          : "Internal task finished immediately.",
      }
    },
  },
  {
    name: "AgentSendMessage",
    permissionTier: "edit",
    description: "Send a follow-up message to an existing sub-agent to continue its work, correct its path, or give new instructions.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "The taskId/agentId of the agent to message." },
        message: { type: "string", description: "The follow-up instructions." },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const to = requireString(input, "to")
      const message = requireString(input, "message")
      if (!context.orchestrator) return formatToolError("Agent Orchestrator not available.")
      await context.orchestrator.sendMessageToAgent(to, message)
      return { ok: true, message: `Message sent to agent ${to}.` }
    },
  },
  {
    name: "AgentStop",
    permissionTier: "edit",
    description: "Stop a running agent task immediately.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The ID of the agent to stop." },
      },
      required: ["agentId"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const agentId = requireString(input, "agentId")
      if (!context.orchestrator) return formatToolError("Agent Orchestrator not available.")
      await context.orchestrator.stopAgent(agentId)
      return { ok: true, message: `Agent ${agentId} stopped.` }
    },
  },
  {
    name: "TriggerBackgroundStudy",
    permissionTier: "edit",
    description: "Spawn a silent background sub-agent to research a topic you don't know well. The sub-agent will search the web and save the compiled findings directly to the Memory Palace using WorkspaceMemoryFiling. Returns immediately.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The specific search terms or topic to research (e.g., 'Next.js 16 app router features')." },
        description: { type: "string", description: "A brief human-readable description of this research task." },
      },
      required: ["query", "description"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const query = requireString(input, "query")
      const description = requireString(input, "description")
      if (!context.orchestrator || !context.sessionId) {
        return formatToolError("Agent Orchestrator or active session not available.")
      }

      const profileId = context.profileId || "default"

      // 1. Configure the session as silent research by default for safety
      try {
        await fileMemory(
          context.rootDir,
          "session_preferences",
          context.sessionId,
          "true",
          profileId,
          "pref_silent_research"
        )
      } catch (err) {
        // Ignore or log non-blocking write error
      }

      // 2. Draft the research worker prompt
      const taskPrompt = [
        `Research topic: ${query}`,
        ``,
        `Your task is to investigate this topic thoroughly.`,
        `1. Use WebSearch (or search_web) to find accurate, up-to-date information.`,
        `2. Compile a structured, detailed summary of your findings.`,
        `3. Save these findings directly to the SQLite Memory Palace using the WorkspaceMemoryFiling tool:`,
        `   - Use wing='SHARED' (or the active profile's wing).`,
        `   - Use room='tech_config' or another relevant room name.`,
        `   - Use a stable key (e.g., 'research_${query.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}').`,
        `   - content should contain the compiled markdown research summary.`,
        `4. Report your final completion in your output text.`,
      ].join("\n")

      // 3. Spawn the task in background mode with isolation 'none' for lightness
      const result = await context.orchestrator.spawnBackgroundTask(
        context.sessionId,
        profileId,
        taskPrompt,
        `Estudiando de fondo: ${description}`,
        undefined,
        { isolation: "none" }
      )

      return {
        ok: true,
        agentId: result.agentId,
        status: result.status,
        message: `Background research agent spawned with ID ${result.agentId}. It will research silently and save results to the Memory Palace.`,
      }
    },
  },
  {
    name: "AgentList",
    permissionTier: "read",
    description: "List available agent profiles that can be used for delegation.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run(_input, context) {
      return { profiles: listProfiles(context.rootDir) }
    },
  },
  {
    name: "ProfileCreate",
    permissionTier: "edit",
    description: "Create a new agent profile with its own identity and workspace.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The unique ID for the profile (e.g. 'coder')." },
        name: { type: "string", description: "Human-friendly name (e.g. 'Expert Coder')." },
        description: { type: "string", description: "Brief description of the agent's purpose." },
      },
      required: ["id", "name"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const id = requireString(input, "id")
      const name = requireString(input, "name")
      const description = optionalString(input, "description")
      
      const newId = createProfile(context.rootDir, id, name, description)
      ensureDirs(context.rootDir, newId)
      ensureBootWings(context.rootDir, newId)
      
      return { ok: true, id: newId, status: "profile_created" }
    },
  },
  // --- ImageSearch via SearxNG Docker ---
  {
    name: "ImageSearch",
    permissionTier: "read",
    description: "Search for images on the internet via SearxNG. Auto-deploys SearxNG Docker container if not running (localhost only). Returns clean image candidates with `image_url` (direct download URL). For simple image requests, use these direct image_url values; do not use WebFetch or scrape source pages. Use VisionAnalyze only if the user explicitly asks to verify/analyze/describe the image content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for images. Be direct and specific." },
        limit: { type: "number", description: "Max number of image URLs to return (default 5)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const query = requireString(input, "query")
      const limit = optionalNumber(input, "limit") ?? 5
      const config = readWebSearchConfig()

      let isAdult = false
      if (context.sessionId && context.runtime && typeof (context.runtime as any).hasAdultMode === "function") {
        isAdult = (context.runtime as any).hasAdultMode(context.sessionId)
      }

      async function fetchWithBackoff(
        url: string,
        init?: RequestInit,
        maxRetries = 2
      ): Promise<Response> {
        let lastError: any = null
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            if (attempt > 0) {
              const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000
              await new Promise(resolve => setTimeout(resolve, delay))
            }
            const res = await fetch(url, init)
            if (res.status === 429 || res.status === 503) {
              lastError = new Error(`HTTP ${res.status}`)
              continue
            }
            return res
          } catch (err) {
            lastError = err
          }
        }
        throw lastError || new Error("Failed after retries")
      }

      async function runSearxngFallback() {
        const deploy = await deploySearxng()
        if (!deploy.ok) {
          throw new Error(`Error auto-desplegando SearxNG: ${deploy.message}`)
        }

        let categories = "images"
        let safesearch = "1"
        if (isAdult) {
          safesearch = "0"
          categories = "images,adult"
        }

        const encoded = encodeURIComponent(query)
        const searchUrl = `${SEARXNG_URL}/search?q=${encoded}&categories=${categories}&format=json&safesearch=${safesearch}`
        const res = await fetch(searchUrl, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) {
          throw new Error(`SearxNG returned HTTP ${res.status}`)
        }
        const data = await res.json()
        return objectArrayField(data, "results")
          .filter(r => typeof r.img_src === "string" && r.img_src.length > 0)
          .slice(0, limit)
          .map(r => {
            const imageUrl = r.img_src as string
            return {
              image_url: imageUrl,
              recommended_download_url: imageUrl,
              recommended_download_field: "image_url" as const,
              fetch_strategy: "download_image_url_directly" as const,
              title: typeof r.title === "string" ? r.title : undefined,
              source: typeof r.source === "string" ? r.source : undefined,
              thumbnail: typeof r.thumbnail_src === "string" ? r.thumbnail_src : undefined,
            }
          })
      }

      let results: Array<{
        image_url: string
        recommended_download_url: string
        recommended_download_field: "image_url"
        fetch_strategy: "download_image_url_directly"
        title?: string
        source?: string
        thumbnail?: string
      }> = []

      try {
        if (config.provider === "brave" && config.apiKey) {
          try {
            const safesearchParam = isAdult ? "off" : "moderate"
            const url = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&safesearch=${safesearchParam}&count=${limit}`
            const response = await fetchWithBackoff(url, {
              headers: { "X-Subscription-Token": config.apiKey, "Accept": "application/json" },
              signal: AbortSignal.timeout(15_000)
            })
            if (!response.ok) {
              throw new Error(`Brave Search returned HTTP ${response.status}`)
            }
            const data = await response.json()
            results = objectArrayField(data, "results").map(r => {
              const properties = typeof r.properties === "object" && r.properties !== null ? r.properties as any : {}
              const thumbnail = typeof r.thumbnail === "object" && r.thumbnail !== null ? r.thumbnail as any : {}
              const imageUrl = properties.url || r.url || ""
              return {
                image_url: imageUrl,
                recommended_download_url: imageUrl,
                recommended_download_field: "image_url" as const,
                fetch_strategy: "download_image_url_directly" as const,
                title: typeof r.title === "string" ? r.title : undefined,
                source: typeof r.source === "string" ? r.source : undefined,
                thumbnail: typeof thumbnail.src === "string" ? thumbnail.src : undefined,
              }
            })
          } catch (err) {
            results = await runSearxngFallback()
          }
        } else if (config.provider === "serper" && config.apiKey) {
          try {
            const response = await fetchWithBackoff("https://google.serper.dev/images", {
              method: "POST",
              headers: { "X-API-KEY": config.apiKey, "Content-Type": "application/json" },
              body: JSON.stringify({
                q: query,
                num: limit,
                safe: isAdult ? "off" : "active"
              }),
              signal: AbortSignal.timeout(15_000)
            })
            if (!response.ok) {
              throw new Error(`Serper API returned HTTP ${response.status}`)
            }
            const data = await response.json()
            results = objectArrayField(data, "images").map(r => {
              const imageUrl = typeof r.imageUrl === "string" ? r.imageUrl : ""
              return {
                image_url: imageUrl,
                recommended_download_url: imageUrl,
                recommended_download_field: "image_url" as const,
                fetch_strategy: "download_image_url_directly" as const,
                title: typeof r.title === "string" ? r.title : undefined,
                source: typeof r.source === "string" ? r.source : (typeof r.domain === "string" ? r.domain : undefined),
                thumbnail: typeof r.thumbnailUrl === "string" ? r.thumbnailUrl : undefined,
              }
            })
          } catch (err) {
            results = await runSearxngFallback()
          }
        } else if (config.provider === "tavily" && config.apiKey) {
          try {
            const response = await fetchWithBackoff("https://api.tavily.com/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                api_key: config.apiKey,
                query: query,
                include_images: true,
                include_image_descriptions: true
              }),
              signal: AbortSignal.timeout(15_000)
            })
            if (!response.ok) {
              throw new Error(`Tavily API returned HTTP ${response.status}`)
            }
            const data = await response.json()
            results = objectArrayField(data, "images").slice(0, limit).map(r => {
              let imageUrl = ""
              let title = query
              if (typeof r === "string") {
                imageUrl = r
              } else if (typeof r === "object" && r !== null) {
                imageUrl = typeof (r as any).url === "string" ? (r as any).url : ""
                title = typeof (r as any).description === "string" ? (r as any).description : query
              }
              return {
                image_url: imageUrl,
                recommended_download_url: imageUrl,
                recommended_download_field: "image_url" as const,
                fetch_strategy: "download_image_url_directly" as const,
                title,
                source: "tavily",
                thumbnail: undefined,
              }
            })
          } catch (err) {
            results = await runSearxngFallback()
          }
        } else {
          // Fallback to SearXNG
          results = await runSearxngFallback()
        }

        return { ok: true, query, count: results.length, results }
      } catch (searchErr) {
        const msg = searchErr instanceof Error ? searchErr.message : String(searchErr)
        return { ok: false, error: `Search failed: ${msg}` }
      }
    },
  },
  {
    name: "VisionAnalyze",
    permissionTier: "read",
    description: "Analiza una imagen desde una URL o un path local utilizando la API de visión del modelo de nube activo (Anthropic, OpenAI, Grok). Rápido (~3-5s). Es la herramienta preferida para análisis visual directo. Si la API de nube falla o devuelve resultado vacío, ejecuta fallback automático al motor de visión local. Retorna { description, local_path }. Usá esta herramienta directamente cuando el usuario pide describir, analizar o verificar el contenido de una imagen — no es necesario delegar a un sub-agente para casos simples.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL de la imagen a descargar y analizar." },
        path: { type: "string", description: "Ruta local del archivo de imagen a analizar." },
      },
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.url !== "string" && typeof input.path !== "string") {
        return "Debes proporcionar 'url' o 'path' como string."
      }
      return null
    },
    async run(input, context) {
      const url = optionalString(input, "url")
      const pathArg = optionalString(input, "path")
      
      let buffer: Buffer
      let mediaType = "image/jpeg"
      let localPath = ""
      
      if (url) {
        if (url.toLowerCase().endsWith(".png")) mediaType = "image/png"
        else if (url.toLowerCase().endsWith(".webp")) mediaType = "image/webp"
        else if (url.toLowerCase().endsWith(".gif")) mediaType = "image/gif"
        
        const response = await fetch(url, { signal: context.abortSignal })
        if (!response.ok) return formatToolError(`Error descargando imagen desde URL: HTTP ${response.status}`)
        buffer = Buffer.from(await response.arrayBuffer())

        const scratchpadDir = join(MONOLITO_ROOT, "workspace", "scratchpad")
        mkdirSync(scratchpadDir, { recursive: true })
        localPath = join(scratchpadDir, `vision-${randomUUID()}.${mediaType === "image/png" ? "png" : "jpg"}`)
        writeFileSync(localPath, buffer)
      } else if (pathArg) {
        if (pathArg.toLowerCase().endsWith(".png")) mediaType = "image/png"
        else if (pathArg.toLowerCase().endsWith(".webp")) mediaType = "image/webp"
        else if (pathArg.toLowerCase().endsWith(".gif")) mediaType = "image/gif"
        
        const absolutePath = resolve(context.cwd, pathArg)
        if (!existsSync(absolutePath)) return formatToolError(`Archivo no encontrado: ${absolutePath}`)
        buffer = readFileSync(absolutePath)
        localPath = absolutePath
      } else {
        return formatToolError("Debes proporcionar 'url' o 'path'.")
      }

      const base64Image = buffer.toString("base64")
      
      const activeProfile = getActiveProfile()
      let provider = "anthropic_compatible"
      let baseUrl = ""
      let apiKey = ""
      let model = ""

      if (activeProfile) {
        provider = activeProfile.provider
        baseUrl = activeProfile.baseUrl.trim().replace(/\/+$/, "")
        apiKey = activeProfile.apiKey.trim()
        model = activeProfile.model.trim()
      } else {
        const settings = readModelSettings()
        provider = "anthropic_compatible"
        baseUrl = settings.env.ANTHROPIC_BASE_URL.trim().replace(/\/+$/, "")
        apiKey = settings.env.ANTHROPIC_AUTH_TOKEN.trim()
        model = settings.env.ANTHROPIC_MODEL.trim()
      }

      if (provider === "xai-oauth") {
        try {
          const { resolveGrokAccessToken } = await import("../runtime/providers/grokAuth.ts")
          apiKey = await resolveGrokAccessToken()
        } catch (err) {
          context.logger?.error(`Error resolving Grok access token in VisionAnalyze: ${err}`)
        }
      }

      if (provider === "anthropic_compatible" || provider === "minimax") {
        const cleanBaseUrl = baseUrl.replace(/\/v1\/messages\/?$/, "")
        const endpoint = cleanBaseUrl ? `${cleanBaseUrl}/v1/messages` : "https://api.anthropic.com/v1/messages"
        
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey || "not-needed",
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: model,
            max_tokens: 1000,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: mediaType,
                      data: base64Image
                    }
                  },
                  {
                    type: "text",
                    text: "Describe exactly what is in this image in detail."
                  }
                ]
              }
            ]
          }),
          signal: context.abortSignal
        })

        if (!response.ok) {
          const text = await response.text()
          return formatToolError(`Anthropic Vision API failed (${response.status}): ${text}`)
        }

        const data = await response.json() as any
        const description = data.content?.[0]?.text || ""
        if (!description) {
          return formatToolError("Vision API returned an empty description. The active model may not support image inputs, or the image was rejected by the provider. Switch to a vision-capable model and try again.")
        }
        return { ok: true, description, local_path: localPath }
      } else {
        const endpoint = baseUrl ? `${baseUrl}/v1/chat/completions` : "https://api.openai.com/v1/chat/completions"
        
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model,
            max_tokens: 1000,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${mediaType};base64,${base64Image}`
                    }
                  },
                  {
                    type: "text",
                    text: "Describe exactly what is in this image in detail."
                  }
                ]
              }
            ]
          }),
          signal: context.abortSignal
        })

        if (!response.ok) {
          const text = await response.text()
          return formatToolError(`OpenAI Vision API failed (${response.status}): ${text}`)
        }

        const data = await response.json() as any
        const description = data.choices?.[0]?.message?.content || ""
        if (!description) {
          return formatToolError("Vision API returned an empty description. The active model may not support image inputs, or the image was rejected by the provider. Switch to a vision-capable model and try again.")
        }
        return { ok: true, description, local_path: localPath }
      }
    },
  },
  {
    name: "WebSearch",
    permissionTier: "read",
    description: "Search the web for current text results via the local SearxNG instance and return clean summaries with title, URL, and snippet. CRÍTICO: PROHIBIDO usar esta herramienta para buscar, ver o analizar IMÁGENES o FOTOS. Solo devuelve texto y fallará. Para cualquier tarea visual o de imágenes, DEBES usar la herramienta de delegación a background.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const query = requireString(input, "query")
      const config = readWebSearchConfig()
      
      let results: Array<{ title: string; url: string; snippet: string }> = []
      
      try {
        if (config.provider === "brave" && config.apiKey) {
          const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`
          const response = await fetch(url, {
            headers: { "X-Subscription-Token": config.apiKey, "Accept": "application/json" },
            signal: AbortSignal.timeout(15_000)
          })
          if (!response.ok) {
            return { ok: false, error: `Brave Search returned HTTP ${response.status}` }
          }
          const data = await response.json()
          results = objectArrayField(data.web, "results").map(result => ({
            title: compactWhitespace(typeof result.title === "string" ? result.title : "Untitled result"),
            url: typeof result.url === "string" ? result.url : "",
            snippet: compactWhitespace(typeof result.description === "string" ? result.description : ""),
          }))
        } else if (config.provider === "serper" && config.apiKey) {
          const response = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "X-API-KEY": config.apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q: query }),
            signal: AbortSignal.timeout(15_000)
          })
          if (!response.ok) {
            return { ok: false, error: `Serper API returned HTTP ${response.status}` }
          }
          const data = await response.json()
          results = objectArrayField(data, "organic").map(result => ({
            title: compactWhitespace(typeof result.title === "string" ? result.title : "Untitled result"),
            url: typeof result.link === "string" ? result.link : "",
            snippet: compactWhitespace(typeof result.snippet === "string" ? result.snippet : ""),
          }))
        } else if (config.provider === "tavily" && config.apiKey) {
          const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: config.apiKey, query: query, include_images: false }),
            signal: AbortSignal.timeout(15_000)
          })
          if (!response.ok) {
            return { ok: false, error: `Tavily API returned HTTP ${response.status}` }
          }
          const data = await response.json()
          results = objectArrayField(data, "results").map(result => ({
            title: compactWhitespace(typeof result.title === "string" ? result.title : "Untitled result"),
            url: typeof result.url === "string" ? result.url : "",
            snippet: compactWhitespace(typeof result.content === "string" ? result.content : ""),
          }))
        } else {
          // Fallback to SearXNG
          const deploy = await deploySearxng()
          if (!deploy.ok) return formatToolError(`Error auto-desplegando SearxNG: ${deploy.message}`)
          const searchUrl = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`
          const response = await fetch(searchUrl, { signal: AbortSignal.timeout(15_000) })
          if (!response.ok) {
            return { ok: false, error: `SearxNG returned HTTP ${response.status}` }
          }
          const data = await response.json()
          results = objectArrayField(data, "results")
            .filter(result => typeof result.url === "string" && result.url.length > 0)
            .map(result => ({
              title: compactWhitespace(typeof result.title === "string" ? result.title : "Untitled result"),
              url: typeof result.url === "string" ? result.url : "",
              snippet: compactWhitespace(typeof result.content === "string" ? result.content : ""),
            }))
        }

        results = results.slice(0, 8)

        const formatted = results.length === 0
          ? "No results found."
          : results
            .map((result, index) => {
              const snippet = result.snippet ? `\n${truncateText(result.snippet, 280)}` : ""
              return `${index + 1}. ${result.title}\n${result.url}${snippet}`
            })
            .join("\n\n")

        // Auto-Scrape de la primera fuente (top result) para enriquecer la respuesta
        let autoFetchContent = ""
        const topResult = results[0]
        if (topResult && topResult.url && !/\.(jpe?g|png|webp|gif|avif|svg|pdf)(\?.*)?$/i.test(topResult.url)) {
          try {
            const fetchRes = await fetch(topResult.url, {
              headers: {
                "User-Agent": "MonolitoV2/1.0",
                "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
              },
              signal: AbortSignal.timeout(3000), // Timeout corto de 3 segundos
            })
            if (fetchRes.ok) {
              const contentType = fetchRes.headers.get("content-type") ?? ""
              const buffer = await fetchRes.arrayBuffer()
              const decoder = new TextDecoder("utf-8", { fatal: false })
              let rawText = decoder.decode(buffer)
              if (rawText) {
                rawText = /<\/?[a-z][\s\S]*>/i.test(rawText)
                  ? htmlToReadableText(rawText)
                  : rawText.replace(/\s+/g, " ").trim()
                if (rawText) {
                  autoFetchContent = rawText.slice(0, 4000) // Primeros 4000 caracteres
                }
              }
            }
          } catch (e) {
            // Silenciosamente ignorar fallas de autofetch
          }
        }

        let finalFormatted = formatted
        if (autoFetchContent) {
          finalFormatted += `\n\n=== CONTENIDO EXTRAÍDO AUTOMÁTICAMENTE DE LA PRIMERA FUENTE (${topResult.url}) ===\n${autoFetchContent}`
        }

        if (context.sessionId) {
          try {
            writeSessionSource(
              context.rootDir,
              context.sessionId,
              `WebSearch:${Date.now()}`,
              `Resultados de búsqueda para "${query}":\n\n${finalFormatted}`,
              context.profileId,
            )
          } catch (e) {
            // Ignorar errores de guardado en caché
          }
        }

        return { ok: true, query, count: results.length, results, formatted: finalFormatted }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: `Search failed: ${message}` }
      }
    },
  },

  // --- Git Tools ---
  {
    name: "GitStatus",
    permissionTier: "read",
    description: "Get the working tree status using git status --porcelain.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run(_input, context) {
      const result = await execFileAsync("git", ["status", "--porcelain", "-b", "-u"], {
        cwd: context.cwd,
        env: process.env,
      })
      return { status: result.stdout.trim() || "(clean)" }
    },
  },
  {
    name: "GitDiff",
    permissionTier: "read",
    description: "Show changes in the working tree that are not yet staged.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run(_input, context) {
      const result = await execFileAsync("git", ["diff"], {
        cwd: context.cwd,
        env: process.env,
      })
      return { diff: result.stdout }
    },
  },
  {
    name: "GitDiffCached",
    permissionTier: "read",
    description: "Show changes that are staged for the next commit.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run(_input, context) {
      const result = await execFileAsync("git", ["diff", "--cached"], {
        cwd: context.cwd,
        env: process.env,
      })
      return { diff: result.stdout }
    },
  },
  {
    name: "GitAdd",
    permissionTier: "edit",
    description: "Add file contents to the staging area.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => typeof input.path === "string" && input.path.length > 0 ? null : "path must be a non-empty string",
    async run(input, context) {
      const path = requireString(input, "path")
      await execFileAsync("git", ["add", path], {
        cwd: context.cwd,
        env: process.env,
      })
      return { ok: true, path }
    },
  },
  {
    name: "GitCommit",
    permissionTier: "edit",
    description: "Record changes to the repository.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => typeof input.message === "string" && input.message.length > 0 ? null : "message must be a non-empty string",
    async run(input, context) {
      const message = requireString(input, "message")
      const result = await execFileAsync("git", ["commit", "-m", message], {
        cwd: context.cwd,
        env: process.env,
      })
      return { ok: true, result: result.stdout }
    },
  },

  // ---------------------------------------------------------------------------
  // Master Configuration Hub
  // ---------------------------------------------------------------------------
  {
    name: "tool_manage_config",
    permissionTier: "edit",
    description: "Read or update technical configuration stored in SQLite CONF_* wings. Use this instead of reading or writing JSON config files manually. ALWAYS wrap channel settings inside their provider key (e.g., { 'telegram': { 'enabled': true } }).\n\nSchemas for wings:\n- CONF_WEBSEARCH: { provider: 'default' | 'searxng' | 'brave' | 'serper' | 'tavily', apiKey?: string } (Brave, Serper and Tavily are cloud search provider APIs)\n- CONF_CHANNELS: { telegram: { enabled: boolean, token?: string, ... }, ... }\n- CONF_SYSTEM: System environment variables\n- CONF_MODELS: Models and provider configuration",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "write", "get", "set", "activate_model"],
          description: "La acción a realizar:\n- 'read': Lee el bloque completo de la sección (wing).\n- 'write': Escribe/reemplaza el bloque completo de la sección.\n- 'get': Lee una propiedad específica usando notación de puntos (ej: 'telegram.enabled').\n- 'set': Modifica una propiedad específica usando notación de puntos (ej: 'telegram.enabled').\n- 'activate_model': Cambia el modelo activo del sistema usando el ID del perfil."
        },
        wing: {
          type: "string",
          enum: [...CONFIG_WING_ORDER],
          description: "La sección de configuración (requerido para 'read', 'write', 'get', 'set')."
        },
        path: {
          type: "string",
          description: "Ruta del valor a leer o modificar en notación de puntos (ej: 'telegram.enabled' o 'profiles.0.active'). Requerido para 'get' y 'set'."
        },
        value: {
          description: "El valor a escribir. Puede ser un JSON string, objeto, array, número, booleano, etc. Requerido para 'write', 'set' y 'activate_model' (donde representa el ID del perfil)."
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => validateZod(manageConfigInputZod, input),
    async run(input, context) {
      const parsed = parseZod(manageConfigInputZod, input, "tool_manage_config input")
      const action = parsed.action
      const wing = parsed.wing

      function getPathValue(obj: any, path: string): any {
        if (!path) return obj
        const parts = path.split(".")
        let current = obj
        for (const part of parts) {
          if (current === null || current === undefined) return undefined
          current = current[part]
        }
        return current
      }

      function setPathValue(obj: any, path: string, val: any): any {
        if (!path) return val
        const parts = path.split(".")
        const last = parts.pop()!
        let current = obj
        for (const part of parts) {
          if (current[part] === undefined || current[part] === null || typeof current[part] !== "object") {
            current[part] = /^\d+$/.test(parts[parts.indexOf(part) + 1] || last) ? [] : {}
          }
          current = current[part]
        }
        current[last] = val
        return obj
      }

      if (action === "activate_model") {
        const profileId = String(parsed.value).trim()
        const target = activateProfile(profileId)
        loadAndApplyModelSettings(process.env)
        return {
          ok: true,
          activeProfile: redactSensitiveValue(target),
          effect: "model_config_reloaded",
        }
      }

      if (!wing) {
        return formatToolError("wing is required")
      }

      if (action === "read") {
        return { wing, value: redactSensitiveValue(readConfigWing(context.rootDir, wing)) }
      }

      if (action === "get") {
        const path = parsed.path || ""
        const config = readConfigWing(context.rootDir, wing)
        const redactedConfig = redactSensitiveValue(config)
        const val = getPathValue(redactedConfig, path)
        return { wing, path, value: val }
      }

      let valueToSave: unknown
      if (action === "write") {
        const val = parseJsonStringValue(parsed.value)
        if (val === undefined) return formatToolError("value is required when action='write'")
        valueToSave = val
      } else if (action === "set") {
        const path = parsed.path || ""
        const val = parseJsonStringValue(parsed.value)
        const currentConfig = JSON.parse(JSON.stringify(readConfigWing(context.rootDir, wing))) // deep copy
        valueToSave = setPathValue(currentConfig, path, val)
      } else {
        return formatToolError(`Unsupported action: ${action}`)
      }

      const normalizedValue = normalizeConfigWingValue(wing, valueToSave)
      const result = writeConfigWing(context.rootDir, wing, normalizedValue as never)
      if (wing === "CONF_SYSTEM" || wing === "CONF_MODELS") {
        loadAndApplyModelSettings(process.env)
      }
      appendActionLog(context.rootDir, "Configuracion tecnica modificada", {
        wing,
        changed: result.changed,
        path: action === "set" ? parsed.path : undefined,
      })
      return {
        wing,
        path: action === "set" ? parsed.path : undefined,
        ok: true,
        changed: result.changed,
        bytes: result.bytes,
        effect: wing === "CONF_SYSTEM" || wing === "CONF_MODELS"
          ? "model_config_reloaded"
          : wing === "CONF_WEBSEARCH" || wing === "CONF_CHANNELS"
            ? "daemon_restart_required"
            : "stored",
      }
    },
  },
  {
    name: "show_master_dashboard",
    aliases: ["master_config", "config_hub"],
    permissionTier: "read",
    description:
      "Opens the Master Configuration Hub — an interactive menu for managing all system settings: models, channels, web search, audio/voice, and system configuration. ALWAYS use this tool (instead of reading config files manually) when the user wants to view or change settings, configure the system, or asks about current configuration. The tool returns a visual interactive menu to the CLI.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run() {
      const { buildMasterDashboard } = await import("../menu/masterDashboard.ts")
      return buildMasterDashboard()
    },
  },
  {
    name: "search_tools",
    permissionTier: "read",
    description: "Busca herramientas disponibles en el registro que coincidan con la descripción o necesidad indicada. Úsala para descubrir nuevas herramientas dinámicamente si no encontrás una específica en tu contexto actual.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "La descripción de la necesidad o funcionalidad que buscás (ej: 'enviar archivos a Telegram', 'buscar en la web')."
        }
      },
      required: ["query"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      try {
        const query = typeof input.query === "string" ? input.query : ""
        const results = await querySemanticTools(context.rootDir, query, 10)
        if (results.length === 0) {
          return "No se encontraron herramientas que coincidan con la búsqueda."
        }
        const matchedTools = tools.filter(t => results.includes(t.name))
        return `Herramientas encontradas:\n${matchedTools.map(t => `- ${t.name}: ${t.description}`).join("\n")}`
      } catch (err) {
        return `Error buscando herramientas: ${err}`
      }
    }
  },
  {
    name: "CreateSkill",
    permissionTier: "edit",
    description: "Crea o actualiza un skill dinámico (habilidad) que proporciona una guía instructiva procedimental (SOP - Standard Operating Procedure) detallada en Markdown sobre cómo encadenar herramientas nativas de Monolito para realizar tareas complejas de forma robusta. Los skills NO son scripts ejecutables. Son manuales operativos que el asistente puede descubrir y leer a través de la herramienta `skill_view` para evitar errores comunes y aplicar mejores prácticas. Si el skill requiere herramientas nativas específicas (ej: ['VisionAnalyze']), decláralas en el array requiresTools.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Nombre único del skill (debe empezar con 'skill_' y usar snake_case, ej: 'skill_commit_build')."
        },
        description: {
          type: "string",
          description: "Una descripción clara y concisa del propósito del skill. Se inyecta en el prompt del sistema y se usa para la búsqueda vectorial."
        },
        guide: {
          type: "string",
          description: "Manual detallado en Markdown (instrucciones paso a paso, numbered steps, herramientas a usar, pitfalls y mitigaciones) sobre cómo resolver el flujo."
        },
        requiresTools: {
          type: "array",
          items: { type: "string" },
          description: "Array opcional de nombres de herramientas nativas de Monolito requeridas para ejecutar este skill (ej: ['VisionAnalyze', 'TelegramSendPhoto'])."
        }
      },
      required: ["name", "description", "guide"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      try {
        const name = String(input.name).trim()
        if (!name.startsWith("skill_")) {
          return { ok: false, error: "El nombre del skill debe empezar con 'skill_'." }
        }
        const description = String(input.description).trim()
        const guide = String(input.guide)
        const requiresTools = Array.isArray(input.requiresTools)
          ? input.requiresTools.map(t => String(t).trim())
          : undefined

        // Provenance: skills created from a synthetic SkillsAgent turn or by a
        // sub-agent are marked as "agent" (eligible for curator). User turns are
        // marked as "user" (protected from curator).
        const provenance: "agent" | "user" = (
          context.sessionId?.startsWith("agent-") ||
          context.sessionId === "skills-synthetic" ||
          // Internal flag set by runSkillsCreate in runtime.ts
          (context as { isSkillsSynthetic?: boolean }).isSkillsSynthetic === true
        ) ? "agent" : "user"

        // Optional security scan for agent-created skills.
        let securityWarning: string | null = null
        if (provenance === "agent") {
          const skillGuardEnabled = readSkillGuardConfig(context.rootDir)
          if (skillGuardEnabled) {
            const scan = scanSkillGuideForThreats(guide)
            if (scan.threat) {
              securityWarning = `Security scan flagged content (pattern: ${scan.pattern}). Review before persisting.`
            }
          }
        }

        const now = new Date().toISOString()
        const skill = {
          name,
          description,
          author: provenance === "agent" ? "skills-agent" : "user",
          guide,
          requiresTools,
          active: true,
          provenance,
          createdAt: now,
          updatedAt: now,
        }

        saveDynamicSkill(context.rootDir, skill)
        // Vectorize semantically right away. The <available_skills> block in the
        // system prompt is built live from listDynamicSkills on every turn — no
        // explicit cache to invalidate.
        await upsertSemanticTool(context.rootDir, name, `Dynamic Skill: ${name} - ${description}`)

        const warningSuffix = securityWarning ? ` WARNING: ${securityWarning}` : ""
        return { ok: true, message: `Skill '${name}' creado (provenance=${provenance}) e indexado semánticamente.${warningSuffix}` }
      } catch (err: any) {
        return { ok: false, error: `Error creando el skill: ${err.message}` }
      }
    }
  },
  {
    name: "DeleteSkill",
    permissionTier: "edit",
    description: "Elimina permanentemente un skill dinámico por su nombre. Las skills con provenance='user' están protegidas contra borrado desde turnos sintéticos (curator, sub-agents) — pero el usuario, hablando a través del LLM en un turno normal, SÍ puede borrarlas. Si querés desactivarla sin perderla, usá ArchiveSkill.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Nombre del skill a eliminar (ej: 'skill_deploy_website')."
        }
      },
      required: ["name"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      try {
        const name = String(input.name).trim()
        const skill = getDynamicSkill(context.rootDir, name)
        if (!skill) {
          return { ok: false, error: `El skill '${name}' no existe.` }
        }
        // Provenance protection applies ONLY when the call comes from a
        // non-user context. The user, through a normal turn, is the ultimate
        // authority over their own skills. The protection is here to stop
        // the curator (synthetic turn) or sub-agents from accidentally
        // deleting things the user created.
        const callerIsUserTurn = (
          !context.sessionId?.startsWith("agent-") &&
          context.sessionId !== "skills-synthetic" &&
          (context as { isSkillsSynthetic?: boolean }).isSkillsSynthetic !== true
        )
        if ((skill.provenance || "user") === "user" && !callerIsUserTurn) {
          return { ok: false, error: `Skill '${name}' tiene provenance='user' y no se puede borrar desde un turno sintético (curator/sub-agent). Usá ArchiveSkill para desactivarla reversiblemente, o pedí al usuario que la borre desde un turno normal.` }
        }
        deleteDynamicSkill(context.rootDir, name)
        return { ok: true, message: `Skill '${name}' eliminado exitosamente del registro y del vector store.` }
      } catch (err: any) {
        return { ok: false, error: `Error eliminando el skill: ${err.message}` }
      }
    }
  },
  {
    name: "ArchiveSkill",
    permissionTier: "edit",
    description: "Archiva (desactiva reversiblemente) un skill dinámico. La skill queda en la base de datos pero deja de aparecer en el bloque <available_skills> del system prompt. Usá RestoreSkill para reactivarla. Usado por el curator para limpiar skills obsoletas sin perderlas.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Nombre del skill a archivar (ej: 'skill_legacy_workflow')."
        },
        reason: {
          type: "string",
          description: "Razón breve del archivado (opcional). Se guarda en el campo archiveReason."
        }
      },
      required: ["name"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      try {
        const name = String(input.name).trim()
        const reason = input.reason ? String(input.reason).trim() : undefined
        const result = archiveDynamicSkill(context.rootDir, name, reason)
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, message: `Skill '${name}' archivado${reason ? ` (motivo: ${reason})` : ""}. Usá RestoreSkill para reactivarlo.` }
      } catch (err: any) {
        return { ok: false, error: `Error archivando el skill: ${err.message}` }
      }
    }
  },
  {
    name: "RestoreSkill",
    permissionTier: "edit",
    description: "Restaura un skill archivado, volviéndolo a hacer visible en el bloque <available_skills> del system prompt.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Nombre del skill a restaurar (ej: 'skill_legacy_workflow')."
        }
      },
      required: ["name"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      try {
        const name = String(input.name).trim()
        const result = restoreArchivedSkill(context.rootDir, name)
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, message: `Skill '${name}' restaurado y activo nuevamente.` }
      } catch (err: any) {
        return { ok: false, error: `Error restaurando el skill: ${err.message}` }
      }
    }
  },
  {
    name: "ListSkills",
    permissionTier: "read",
    description: "Lista todas las habilidades dinámicas creadas, mostrando su estado, provenance y telemetría de uso.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run(input, context) {
      try {
        // Include archived ones so the curator can see them; the LLM in normal
        // turns rarely calls this and is allowed to see archived state.
        const skills = listDynamicSkills(context.rootDir, { includeArchived: true })
        if (skills.length === 0) {
          return "No hay skills dinámicos registrados en este momento."
        }
        const formatted = skills.map(s => {
          const telemetry = s.telemetry || { use_count: 0, last_used_at: "nunca", failure_count: 0 }
          const provenance = s.provenance || "user"
          const status = s.active ? "ACTIVO" : `ARCHIVADO${s.archiveReason ? `: ${s.archiveReason}` : ""}`
          return `* ${s.name} [${provenance}] (${status})
  - Descripción: ${s.description}
  - Autor: ${s.author}
  - Usos: ${telemetry.use_count} | Fallos: ${telemetry.failure_count}
  - Último Uso: ${telemetry.last_used_at}
  - Creado: ${s.createdAt || "desconocido"}
  - Herramientas Requeridas: ${s.requiresTools && s.requiresTools.length > 0 ? s.requiresTools.join(", ") : "Ninguna"}`
        }).join("\n\n")
        return `Skills dinámicos registrados:\n\n${formatted}`
      } catch (err: any) {
        return `Error listando skills: ${err.message}`
      }
    }
  },
  {
    name: "GenerateImage",
    permissionTier: "edit",
    description: "Genera una imagen a partir de una descripción detallada (prompt). Soporta xAI Grok (grok-imagine-image) por defecto si la sesión está autenticada, o DALL-E si está configurado.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Descripción detallada de la imagen a generar (ej: 'Un gato de estilo cyberpunk con ojos de neón brillante')." },
        aspect_ratio: { type: "string", enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], description: "Relación de aspecto de la imagen generada. Por defecto es '1:1'." },
        quality: { type: "string", enum: ["standard", "quality"], description: "Calidad de generación. Por defecto es 'standard'. 'quality' produce mayor nivel de detalle (solo soportado por Grok)." },
        provider: { type: "string", enum: ["xai", "openai"], description: "Forzar un proveedor específico. Por defecto detecta automáticamente basándose en las credenciales del perfil activo." }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
        return "El prompt de generación no puede estar vacío."
      }
      return null
    },
    async run(input, context) {
      try {
        const prompt = requireString(input, "prompt")
        const aspect_ratio = optionalString(input, "aspect_ratio") || "1:1"
        const quality = optionalString(input, "quality") || "standard"
        const providerOverride = optionalString(input, "provider")

        // 1. Resolve Provider and Credentials
        let provider = "xai"
        let baseUrl = "https://api.x.ai/v1"
        let apiKey = ""
        let model = ""

        const activeProfile = getActiveProfile()

        if (providerOverride === "xai") {
          provider = "xai"
        } else if (providerOverride === "openai") {
          provider = "openai"
        } else {
          // Auto-detect
          if (activeProfile && ((activeProfile.provider as string) === "xai-oauth" || (activeProfile.provider as string) === "xai" || activeProfile.baseUrl.includes("x.ai"))) {
            provider = "xai"
          } else {
            const { loadGrokTokens } = await import("../runtime/providers/grokAuth.ts")
            const hasGrokTokens = await loadGrokTokens().then(t => !!t).catch(() => false)
            const hasGrokEnv = !!process.env.XAI_API_KEY
            if (hasGrokTokens || hasGrokEnv) {
              provider = "xai"
            } else if (activeProfile && (activeProfile.provider === "openai_compatible" || activeProfile.provider === "anthropic_compatible")) {
              provider = "openai"
            } else {
              provider = "xai"
            }
          }
        }

        // Resolve credentials
        if (provider === "xai") {
          baseUrl = "https://api.x.ai/v1"
          if (activeProfile && ((activeProfile.provider as string) === "xai-oauth" || (activeProfile.provider as string) === "xai")) {
            apiKey = activeProfile.apiKey.trim()
            if ((activeProfile.provider as string) === "xai-oauth") {
              try {
                const { resolveGrokAccessToken } = await import("../runtime/providers/grokAuth.ts")
                apiKey = await resolveGrokAccessToken()
              } catch (err) {
                context.logger?.error(`Error resolving Grok access token: ${err}`)
              }
            }
          } else {
            if (process.env.XAI_API_KEY) {
              apiKey = process.env.XAI_API_KEY.trim()
            } else {
              try {
                const { resolveGrokAccessToken } = await import("../runtime/providers/grokAuth.ts")
                apiKey = await resolveGrokAccessToken()
              } catch (err) {
                // Ignore, we fail later
              }
            }
          }
          model = quality === "quality" ? "grok-imagine-image-quality" : "grok-imagine-image"
        } else {
          // OpenAI
          if (activeProfile) {
            baseUrl = activeProfile.baseUrl.trim().replace(/\/+$/, "")
            apiKey = activeProfile.apiKey.trim()
            model = activeProfile.model.trim() || "dall-e-3"
          } else {
            baseUrl = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1"
            apiKey = process.env.OPENAI_API_KEY?.trim() || ""
            model = "dall-e-3"
          }
        }

        if (!apiKey) {
          return formatToolError(
            `No se encontraron credenciales válidas para el proveedor '${provider}'. ` +
            `Por favor, configura xAI Grok OAuth ejecutando 'monolito auth xai-oauth' en tu terminal, ` +
            `o configura la variable de entorno XAI_API_KEY / OPENAI_API_KEY.`
          )
        }

        // 2. Prepare Endpoint and Payload
        let endpoint = `${baseUrl.replace(/\/+$/, "")}/images/generations`
        let payload: Record<string, any> = {}

        if (provider === "xai" || baseUrl.includes("x.ai")) {
          payload = {
            model: model,
            prompt: prompt,
            aspect_ratio: aspect_ratio,
            resolution: "1k"
          }
        } else {
          let size = "1024x1024"
          if (aspect_ratio === "16:9") {
            size = "1792x1024"
          } else if (aspect_ratio === "9:16") {
            size = "1024x1792"
          } else if (aspect_ratio === "4:3") {
            size = "1024x768"
          } else if (aspect_ratio === "3:4") {
            size = "768x1024"
          }
          payload = {
            model: model || "dall-e-3",
            prompt: prompt,
            size: size,
            n: 1
          }
        }

        context.logger?.info(`Iniciando generación de imagen con '${provider}' y modelo '${model}'...`)

        // 3. Request
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify(payload),
          signal: context.abortSignal
        })

        if (!response.ok) {
          const errorText = await response.text()
          return formatToolError(`La API de generación de imágenes falló (${response.status}): ${errorText}`)
        }

        const result = await response.json() as any
        const data = result.data || []
        if (data.length === 0) {
          return formatToolError("La API no devolvió ninguna imagen en la respuesta.")
        }

        const first = data[0]
        const b64 = first.b64_json
        const imageUrl = first.url

        // 4. Save Locally
        const scratchpadDir = join(MONOLITO_ROOT, "workspace", "scratchpad")
        mkdirSync(scratchpadDir, { recursive: true })

        let localPath = ""
        let isPng = true

        if (b64) {
          const buffer = Buffer.from(b64, "base64")
          localPath = join(scratchpadDir, `img-gen-${randomUUID()}.png`)
          writeFileSync(localPath, buffer)
        } else if (imageUrl) {
          const imgResponse = await fetch(imageUrl, { signal: context.abortSignal })
          if (!imgResponse.ok) {
            return formatToolError(`No se pudo descargar la imagen generada desde la URL: HTTP ${imgResponse.status}`)
          }
          const buffer = Buffer.from(await imgResponse.arrayBuffer())
          if (imageUrl.toLowerCase().endsWith(".jpg") || imageUrl.toLowerCase().endsWith(".jpeg")) {
            isPng = false
          }
          localPath = join(scratchpadDir, `img-gen-${randomUUID()}.${isPng ? "png" : "jpg"}`)
          writeFileSync(localPath, buffer)
        } else {
          return formatToolError("La respuesta no contiene ni 'b64_json' ni 'url'.")
        }

        context.logger?.info(`Imagen generada exitosamente en: ${localPath}`)

        return JSON.stringify({
          success: true,
          local_path: localPath,
          url: imageUrl || null,
          provider: provider,
          model: model,
          prompt: prompt,
          aspect_ratio: aspect_ratio
        }, null, 2)

      } catch (err: any) {
        return formatToolError(`Error durante la generación de la imagen: ${err.message}`)
      }
    }
  },
  {
    name: "skill_view",
    permissionTier: "read",
    description: "Recupera las instrucciones procedimentales detalladas (SOP - Standard Operating Procedure) de un skill dinámico específico por su nombre.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Nombre del skill a consultar (debe empezar con 'skill_', ej: 'skill_commit_build')."
        }
      },
      required: ["name"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      try {
        const name = String(input.name).trim()
        const skill = getDynamicSkill(context.rootDir, name)
        if (!skill) {
          return `El skill '${name}' no existe en el registro.`
        }
        if (!skill.active) {
          return `El skill '${name}' existe pero está inactivo en este momento.`
        }
        // Telemetry: increment use_count with debounce. Skipping writes if the
        // last_used_at is within the debounce window prevents SQLite thrashing
        // when the LLM reads the same skill multiple times in one turn.
        if (shouldRecordSkillUse(skill)) {
          try {
            incrementSkillTelemetry(context.rootDir, name, true)
          } catch (telemetryErr) {
            // Telemetry failures must not break the tool — log and continue.
            context.logger?.warn?.(`skill_view telemetry failed for '${name}': ${telemetryErr}`)
          }
        }
        return `# Skill: ${skill.name} (SOP Manual)\n\n${skill.guide}`
      } catch (err: any) {
        return `Error al consultar el skill: ${err.message}`
      }
    }
  },
]

const tools: ToolDefinition[] = rawTools.map(withSafeToolFailure)

function isValidJson(value: string) {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

export function listTools() {
  return tools
}

export function listModelTools(isSubAgent = false, lastUserText?: string | boolean | string[], allowedToolNames?: string[], rootDir?: string, exposeTelegramDownload = false) {
  const hiddenFromSubAgents = new Set([
    "AgentSpawn",
    "AgentSendMessage",
    "AgentStop",
    "delegate_background_task",
    "list_active_workers",
    "TelegramSend",
    "TelegramSendAudio",
    "TelegramSendVoice",
    "TelegramSendPhoto",
    "TelegramSendDocument",
    "schedule_task",
    "system_reboot",
    "system_status",
    "QueryCost",
    "QuerySessionStats",
    "CompactSession",
    "SttServiceStatus",
    "SttServiceDeploy",
    "SttServiceStop",
    "SttServiceRemove",
    "SttServiceList",
    "TranscribeAudio",
    "TtsServiceStatus",
    "TtsServiceDeploy",
    "TtsServiceStop",
    "TtsServiceRemove",
    "TtsServiceList",
    "GenerateSpeech",
    "tool_manage_config",
    "ProfileCreate",
    "AgentList",
    "TelegramDownloadFile"
  ])
  const hiddenFromMainSession = new Set([
    "TelegramDownloadFile"
  ])

  if (exposeTelegramDownload) {
    hiddenFromSubAgents.delete("TelegramDownloadFile")
    hiddenFromMainSession.delete("TelegramDownloadFile")
  }

  const blockedTools = Array.isArray(lastUserText)
    ? lastUserText
    : typeof lastUserText === "boolean"
      ? (lastUserText ? ["AgentList", "ProfileCreate", "Write", "Edit", "MultiEdit", "Bash", "TodoWrite"] : [])
      : (typeof lastUserText === "string" && lastUserText === "true")
        ? ["AgentList", "ProfileCreate", "Write", "Edit", "MultiEdit", "Bash", "TodoWrite"]
        : (typeof lastUserText === "string" && /imagen|imagenes|foto|fotos|picture|pictures|image|images|vision|visual/i.test(lastUserText))
          ? ["AgentList", "ProfileCreate", "Write", "Edit", "MultiEdit", "Bash", "TodoWrite"]
          : []

  const CORE_TOOLS = new Set([
    "TodoWrite",
    "TodoList",
    "delegate_background_task",
    "search_tools",
    "Bash",
    "Write",
    "Edit",
    "MultiEdit",
    "AgentSendMessage",
    "AgentSpawn",
    "AgentStop",
    "TelegramSend",
    "TelegramSendPhoto",
    "ImageSearch",
    "DownloadFile",
    "GenerateImage",
    "VisionAnalyze",
  ])

  const staticMapped = tools
    .filter(tool => {
      // 1. Core Tools are ALWAYS included
      if (CORE_TOOLS.has(tool.name)) {
        if (isSubAgent && hiddenFromSubAgents.has(tool.name)) return false;
        if (isSubAgent && blockedTools.includes(tool.name)) return false;
        if (!isSubAgent && hiddenFromMainSession.has(tool.name)) return false;
        return true;
      }

      // 2. If allowedToolNames is supplied, only allow those tools
      if (allowedToolNames && !allowedToolNames.includes(tool.name)) return false;

      // 3. Apply standard static filters for all other tools
      if (isSubAgent && hiddenFromSubAgents.has(tool.name)) return false;
      if (isSubAgent && blockedTools.includes(tool.name)) return false;
      if (!isSubAgent && hiddenFromMainSession.has(tool.name)) return false;
      if (!isSubAgent && blockedTools.includes("Bash") && (tool.name === "WebSearch" || tool.name === "WebFetch")) return false;
      return true;
    })
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
  return staticMapped
}

export function getTool(name: string) {
  const normalized = name.toLowerCase()
  return tools.find(tool =>
    tool.name.toLowerCase() === normalized ||
    tool.aliases?.some(alias => alias.toLowerCase() === normalized),
  ) ?? null
}

export function validateToolInput(name: string, input: Record<string, unknown>) {
  const tool = getTool(name)
  if (!tool) return `Unknown tool: ${name}`
  return tool.validate?.(input) ?? null
}

export function isToolConcurrencySafe(name: string, input: Record<string, unknown>) {
  const tool = getTool(name)
  if (!tool) return false
  if (typeof tool.concurrencySafe === "function") return tool.concurrencySafe(input)
  return tool.concurrencySafe === true
}

export function isToolSideEffect(name: string): boolean {
  const tool = getTool(name)
  return tool?.sideEffect === true
}

export async function indexToolsInPalace(rootDir: string) {
  for (const tool of tools) {
    const formattedDesc = `${tool.name}: ${tool.description}`
    try {
      await upsertSemanticTool(rootDir, tool.name, formattedDesc)
    } catch (err) {
      console.error(`[indexToolsInPalace] Failed to index ${tool.name}:`, err)
    }
  }

  try {
    const activeSkills = listDynamicSkills(rootDir).filter(s => s.active)
    for (const skill of activeSkills) {
      const formattedDesc = `Dynamic Skill: ${skill.name} - ${skill.description}`
      await upsertSemanticTool(rootDir, skill.name, formattedDesc)
    }
  } catch (err) {
    console.error(`[indexToolsInPalace] Failed to index dynamic skills:`, err)
  }
}

export async function indexRalphRulesInPalace(rootDir: string) {
  const imageVerificationRule = {
    name: "Image Verification Rule",
    description: "Checks if the task requests visual verification, validation, analysis, description, or confirmation of images, photos, screenshots, or visual assets.",
    intentRegex: "\\b(imagen(?:es)?|foto(?:s)?|picture(?:s)?|photo(?:s)?|image(?:s)?|vision|visual)\\b",
    requiredRegex: "\\b(verifica(?:r|me|las|los)?|valid(?:a|ar|ame|alas|alos)|analiza(?:r|me|las|los)?|describe(?:me|las|los)?|confirm(?:a|ar|ame)|vision|visual|coincid(?:e|an)|contenido|real(?:es)?|correct(?:a|as|o|os))\\b",
    requiredTools: ["VisionAnalyze"],
    errorMessage: "[Ralph Loop] SYSTEM ALERT\nTu respuesta incluye el tag de éxito pero NO ejecutaste la herramienta de visión (VisionAnalyze).\nPara tareas de imágenes, es OBLIGATORIO descargar y validar visualmente con VisionAnalyze.\nNo podés cerrar la tarea diciendo que lo hiciste sin haber llamado a la tool.\nCorregilo: buscá la imagen, descargala y pasale la ruta a la herramienta antes de responder."
  }

  try {
    upsertRalphRule(rootDir, "image_verification", JSON.stringify(imageVerificationRule, null, 2))
  } catch (err) {
    console.error("[indexRalphRulesInPalace] Failed to index image_verification rule:", err)
  }

  // The enumerate_dynamic_state rule is enforced semantically via the
  // EVIDENCE-FIRST RULE in the orchestrator system prompt. The orchestrator's
  // checkDynamicRalphRules uses a hard requiredTools list to decide if the
  // rule applies, but this rule covers many resources (skills, files,
  // channels, processes, configs, profiles, models) — each one maps to a
  // different tool. A hardcoded requiredTools list would either be
  // too narrow (blocking legitimate tool calls) or too broad (never firing).
  // We keep the rule definition as documentation but skip the tool-list
  // enforcement by passing an empty requiredTools array, which makes the
  // orchestrator skip the check (see orchestrator.ts checkDynamicRalphRules).
  const enumerateDynamicStateRule = {
    name: "Enumerate Dynamic State Rule",
    description: "Checks if the user is asking to enumerate, list, show, count, or inventory the current state of a dynamic system resource (skills, sessions, files, channels, tools, processes, configs). When the user asks for a live enumeration, the answer must come from a tool, not from memory.",
    intentRegex: "\\b(listame|lista|listas|listar|enumera|enumerar|mostrame|mostrar|ensename|ensenar|dime\\s+(?:que|cuales|cuantas|cuantos|qué|cuáles|cuántas|cuántos)|inventario|inventaria|qué\\s+(?:skills|herramientas|sessions|sesiones|archivos|files|tools|tienes|hay|existen)|how\\s+many|cuantas?\\s+(?:skills|herramientas|sessions|sesiones|archivos|files|tools|hay)|show\\s+(?:me\\s+)?(?:all\\s+)?(?:your\\s+)?(?:skills|sessions|files|tools))\\b",
    requiredRegex: "\\b(skills?|herramientas?|tools?|sessions?|sesiones?|archivos?|files?|canales?|channels?|procesos?|processes?|configs?|profiles?|modelos?|models?)\\b",
    requiredTools: [],
    errorMessage: "[Ralph Loop] SYSTEM ALERT\nEl usuario pidió enumerar/listar el estado actual de un recurso dinámico del sistema (skills, sessions, archivos, tools, etc.).\nTu respuesta parece basada en memoria/recuerdo, NO en una tool ejecutada en este turno.\nEsto está PROHIBIDO. La respuesta correcta es ejecutar la tool correspondiente (ListSkills para skills, Read/Glob/list_files para archivos, etc.) y reportar lo que la tool devuelve.\nNO respondas desde memoria con disclaimers ('tomátelo con pinzas', 'no verifiqué', 'si querés el 100% decime').\nCorregilo: ejecutá la tool apropiada y respondé con el resultado real."
  }

  try {
    upsertRalphRule(rootDir, "enumerate_dynamic_state", JSON.stringify(enumerateDynamicStateRule, null, 2))
  } catch (err) {
    console.error("[indexRalphRulesInPalace] Failed to index enumerate_dynamic_state rule:", err)
  }
}


