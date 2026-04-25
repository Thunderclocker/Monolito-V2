import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { ensureDirs, getPaths } from "../ipc/protocol.ts"
import { MONOLITO_ROOT } from "../system/root.ts"
import { type McpClient, createMcpClient, getDefaultMcpServers } from "../mcp/client.ts"
import { getSharedLspClient } from "../lsp/client.ts"
import { normalizeChannelsConfigForWrite, readChannelsConfig } from "../channels/config.ts"
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
  readCanonicalMemory,
  writeCanonicalMemory,
  ensureBootWings,
  readConfigWing,
  writeConfigWing,
  getSession,
  listSessions,
  tailEvents,
} from "../session/store.ts"
import { isEmbeddingsUnavailableError } from "../session/embeddings.ts"
import { type AgentOrchestrator } from "../runtime/orchestrator.ts"
import { redactSensitiveValue } from "../security/redact.ts"
import { type Logger } from "../logging/logger.ts"
import { BOOT_WING_ORDER, isBootWingName } from "../bootstrap/bootWings.ts"
import { CONFIG_WING_ORDER, type ConfigWingName } from "../config/configWings.ts"
import { coerceConfigRecord } from "../config/wingValue.ts"
import { loadAndApplyModelSettings } from "../runtime/modelConfig.ts"
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
import { analyzeManagedImage, normalizeVisionConfig } from "../vision/managed.ts"
import { deploySearxng, SEARXNG_URL } from "../websearch/managed.ts"

const execFileAsync = promisify(execFile)
const DEFAULT_GREP_LIMIT = 250
const DEFAULT_BASH_TIMEOUT_MS = 120_000
const MAX_EXEC_BUFFER = 4 * 1024 * 1024
const TELEGRAM_AUDIO_FORMATS = new Set(["mp3", "m4a", "aac"])
const TELEGRAM_VOICE_FORMATS = new Set(["ogg", "opus"])
const TTS_RESPONSE_FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"])

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
  runtime?: { acquireJobGroupForBatch: (sessionId: string) => string }
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
  validate?: (input: Record<string, unknown>) => string | null
  run: (input: Record<string, unknown>, context: ToolContext) => Promise<unknown>
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

function resolveWorkspacePath(rootDir: string, cwd: string, target = ".") {
  const allowedRoots = [resolve(rootDir), resolve(MONOLITO_ROOT)]
  const absolute = resolve(cwd, target)
  const allowed = allowedRoots.some(root => absolute === root || absolute.startsWith(`${root}${sep}`))
  if (!allowed) {
    throw new Error(`Path escapes workspace: ${target}`)
  }
  return absolute
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

function normalizeConfigWingValue(wing: ConfigWingName, value: unknown) {
  if (wing === "CONF_CHANNELS") {
    return normalizeChannelsConfigForWrite(value)
  }
  if (wing === "CONF_MODELS" || wing === "CONF_SYSTEM" || wing === "CONF_WEBSEARCH") {
    return coerceConfigRecord(value) ?? value
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

function isLocalPath(value: string) {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/")
}

async function telegramApiCallWithFile(
  token: string,
  method: string,
  fileField: string,
  filePath: string,
  params: Record<string, unknown>,
) {
  const resolvedPath = filePath.startsWith("~/")
    ? filePath.replace("~/", `${process.env.HOME ?? ""}/`)
    : filePath

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

  const paths = ensureDirs(rootDir)
  const downloadsDir = join(paths.scratchpadDir, "telegram-downloads")
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

const tools: ToolDefinition[] = [
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
      if (!sessionId) throw new Error("sessionId is required")
      if (!context.querySessionStatus) throw new Error("Session status query is not available in this context")
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
      if (!context.queryCost) throw new Error("Cost query is not available in this context")
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
      if (!sessionId) throw new Error("sessionId is required")
      if (!context.queryStats) throw new Error("Session stats query is not available in this context")
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
      if (!sessionId) throw new Error("sessionId is required")
      if (!context.compactSession) throw new Error("Session compaction is not available in this context")
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
      const directory = resolveWorkspacePath(context.rootDir, context.cwd, target)
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
      const file = resolveWorkspacePath(context.rootDir, context.cwd, path)
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
      const file = resolveWorkspacePath(context.rootDir, context.cwd, path)
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
      const file = resolveWorkspacePath(context.rootDir, context.cwd, path)
      const original = readFileSync(file, "utf8")
      const matches = findStringOccurrences(original, oldString)
      const occurrences = matches.length
      if (occurrences === 0) throw new Error(`old_string not found in ${path}`)
      if (replaceAll && matchIndex !== undefined) {
        throw new Error("match_index cannot be combined with replace_all=true")
      }
      if (!replaceAll && occurrences > 1) {
        if (matchIndex === undefined) {
          const lineSummary = matches.map((match, index) => `${index}:${match.line}`).join(", ")
          throw new Error(`old_string matched ${occurrences} times in ${path} at match_index:line ${lineSummary}; retry with match_index or set replace_all=true`)
        }
        if (!Number.isInteger(matchIndex) || matchIndex < 0 || matchIndex >= occurrences) {
          throw new Error(`match_index ${matchIndex} is out of range for ${occurrences} matches in ${path}`)
        }
      }
      let updated = original
      let replaced = 0
      if (replaceAll) {
        updated = original.split(oldString).join(newString)
        replaced = occurrences
      } else if (matchIndex !== undefined) {
        const match = matches[matchIndex]
        if (!match) throw new Error(`match_index ${matchIndex} is out of range for ${occurrences} matches in ${path}`)
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
      const absoluteTarget = resolveWorkspacePath(context.rootDir, context.cwd, target)
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
      const absoluteTarget = resolveWorkspacePath(context.rootDir, context.cwd, target)
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
    description: "Execute a shell command locally from the workspace. Optional: run_in_background=true for long-running commands.",
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
      const absoluteFile = resolveWorkspacePath(context.rootDir, context.rootDir, file)
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
    async run(input) {
      const url = requireString(input, "url")
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
    description: "Add a task to the session task list. Tasks are private to the current profile and session.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        status: { type: "string", enum: ["in_progress", "completed", "pending"] },
      },
      required: ["content"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const content = requireString(input, "content")
      const status = optionalString(input, "status") ?? "pending"
      const profileId = context.profileId || "default"
      const paths = getPaths(context.rootDir, profileId)
      const taskFile = join(paths.profilesDir, profileId, "tasks.json")
      
      let tasks: Array<{ id: string; content: string; status: string; createdAt: string; sessionId?: string }> = []
      try {
        if (existsSync(taskFile)) {
          tasks = JSON.parse(readFileSync(taskFile, "utf8"))
        }
      } catch {}
      
      const task = {
        id: randomUUID().slice(0, 8),
        sessionId: (context as any).sessionId,
        content,
        status,
        createdAt: new Date().toISOString(),
      }
      tasks.push(task)
      mkdirSync(dirname(taskFile), { recursive: true })
      writeFileSync(taskFile, JSON.stringify(tasks, null, 2))
      return { task, total: tasks.length, profile: profileId }
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
        if (!deploy.ok) throw new Error(deploy.message)
      }
      const result = await transcribeManagedAudioFile(path, stt)
      if (!result.ok) throw new Error(result.error ?? "STT transcription failed")
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
    description: "Deploy or restart the managed local TTS service container using Docker. Cleans conflicting legacy OpenAI Edge TTS containers first.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      return await deployManagedTtsContainer(tts)
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
    description: "Generate a speech audio file with the configured OpenAI-compatible TTS backend and save it to Monolito scratchpad storage.",
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
          if (!deploy.ok) throw new Error(deploy.message)
        }
      }
      if (!baseUrl) {
        throw new Error("TTS base URL is not configured. Use /config set tts_base_url <value> or enable managed TTS.")
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
        throw new Error(`TTS request failed: HTTP ${response.status}${body ? ` - ${body.slice(0, 400)}` : ""}`)
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
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
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
        throw new Error(`Telegram API error: ${data.description ?? response.status}`)
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
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const params: Record<string, unknown> = { chat_id: chatId, audio }
      if (caption) params.caption = caption
      if (title) params.title = title
      if (performer) params.performer = performer
      const data = isLocalPath(audio)
        ? await telegramApiCallWithFile(config.telegram.token, "sendAudio", "audio", audio, params)
        : await telegramApiCall(config.telegram.token, "sendAudio", params)
      if (!data.ok) throw new Error(`Telegram API error: ${data.description ?? "sendAudio failed"}`)
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
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const params: Record<string, unknown> = { chat_id: chatId, voice }
      if (caption) params.caption = caption
      const data = isLocalPath(voice)
        ? await telegramApiCallWithFile(config.telegram.token, "sendVoice", "voice", voice, params)
        : await telegramApiCall(config.telegram.token, "sendVoice", params)
      if (!data.ok) throw new Error(`Telegram API error: ${data.description ?? "sendVoice failed"}`)
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
      },
      required: ["chat_id", "photo"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.chat_id !== "number") return "chat_id must be a number"
      if (typeof input.photo !== "string" || input.photo.length === 0) return "photo must be a non-empty string"
      return null
    },
    async run(input) {
      const chatId = input.chat_id as number
      const photo = requireString(input, "photo")
      const caption = optionalString(input, "caption")
      const parseMode = optionalString(input, "parse_mode")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const params: Record<string, unknown> = { chat_id: chatId, photo }
      if (caption) params.caption = caption
      if (parseMode) params.parse_mode = parseMode
      const data = isLocalPath(photo)
        ? await telegramApiCallWithFile(config.telegram.token, "sendPhoto", "photo", photo, params)
        : await telegramApiCall(config.telegram.token, "sendPhoto", params)
      if (!data.ok) throw new Error(`Telegram API error: ${data.description ?? "sendPhoto failed"}`)
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
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const params: Record<string, unknown> = { chat_id: chatId, document }
      if (caption) params.caption = caption
      const data = isLocalPath(document)
        ? await telegramApiCallWithFile(config.telegram.token, "sendDocument", "document", document, params)
        : await telegramApiCall(config.telegram.token, "sendDocument", params)
      if (!data.ok) throw new Error(`Telegram API error: ${data.description ?? "sendDocument failed"}`)
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
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const data = await telegramApiCall(config.telegram.token, "getFile", { file_id: fileId })
      if (!data.ok) throw new Error(`Telegram API error: ${data.description ?? "getFile failed"}`)
      return { ok: true, file: data.result }
    },
  },
  {
    name: "TelegramDownloadFile",
    permissionTier: "edit",
    description: "Download a Telegram file_id into Monolito scratchpad storage and return the local path.",
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
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
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
      const paths = getPaths(context.rootDir, profileId)
      const taskFile = join(paths.profilesDir, profileId, "tasks.json")
      
      let tasks: Array<{ id: string; content: string; status: string; createdAt: string; sessionId?: string }> = []
      try {
        if (existsSync(taskFile)) {
          tasks = JSON.parse(readFileSync(taskFile, "utf8"))
        }
      } catch {}
      
      // Filter by session first
      let sessionTasks = sessionId ? tasks.filter(t => t.sessionId === sessionId) : tasks
      const filtered = filter === "all" ? sessionTasks : sessionTasks.filter(t => t.status === filter)
      
      return { 
        tasks: filtered, 
        totalInSession: sessionTasks.length, 
        totalInProfile: tasks.length,
        filter,
        profile: profileId
      }
    },
  },
  {
    name: "BootRead",
    permissionTier: "read",
    description: "Read a deterministic BOOT wing from SQLite without relying on legacy workspace files.",
    inputSchema: {
      type: "object",
      properties: {
        wing: { type: "string", enum: [...BOOT_WING_ORDER] },
      },
      required: ["wing"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const wing = requireString(input, "wing")
      if (!isBootWingName(wing)) throw new Error(`Unsupported BOOT wing: ${wing}`)
      ensureBootWings(context.rootDir, context.profileId ?? "default")
      const content = readBootWing(context.rootDir, wing, context.profileId ?? "default")
      if (content == null) throw new Error(`BOOT wing ${wing} not found in profile ${context.profileId ?? "default"}`)
      return { wing, content, profile: context.profileId ?? "default" }
    },
  },
  {
    name: "BootWrite",
    permissionTier: "edit",
    description: "Replace the canonical content of a deterministic BOOT wing in SQLite.",
    inputSchema: {
      type: "object",
      properties: {
        wing: { type: "string", enum: [...BOOT_WING_ORDER] },
        content: { type: "string" },
      },
      required: ["wing", "content"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    async run(input, context) {
      const wing = requireString(input, "wing")
      const content = requireString(input, "content")
      if (!isBootWingName(wing)) throw new Error(`Unsupported BOOT wing: ${wing}`)
      const result = writeBootWing(context.rootDir, wing, content, context.profileId ?? "default")
      return { wing, ok: true, changed: result.changed, bytes: result.bytes, profile: context.profileId ?? "default" }
    },
  },
  {
    name: "CanonicalMemoryRead",
    permissionTier: "read",
    description: "Read stable structured identity/profile memory such as assistant name, user preferred name, location, and timezone.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run(_input, context) {
      const state = readCanonicalMemory(context.rootDir, context.profileId ?? "default")
      return {
        profile: context.profileId ?? "default",
        state,
      }
    },
  },
  {
    name: "CanonicalMemoryWrite",
    permissionTier: "edit",
    description: "Write a stable structured identity/profile fact. Prefer this over BOOT_* for confirmed assistant/user facts.",
    inputSchema: {
      type: "object",
      properties: {
        slot: { type: "string", enum: ["assistant_name", "user_name", "user_preferred_name", "user_location", "user_timezone"] },
        value: { type: "string" },
      },
      required: ["slot", "value"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    async run(input, context) {
      const slot = requireString(input, "slot") as "assistant_name" | "user_name" | "user_preferred_name" | "user_location" | "user_timezone"
      const value = requireString(input, "value")
      const result = await writeCanonicalMemory(context.rootDir, slot, value, context.profileId ?? "default")
      return {
        ok: true,
        profile: context.profileId ?? "default",
        slot,
        value: result.value,
        changed: result.changed,
        bytes: result.bytes,
      }
    },
  },
  {
    name: "WorkspaceMemoryFiling",
    permissionTier: "edit",
    description: "Store facts, decisions, or snippets in the SQLite Memory Palace. Use wing='SHARED' for team-wide memory visible to every profile. Any other wing stays private to the current profile.",
    inputSchema: {
      type: "object",
      properties: {
        wing: { type: "string", description: "Wing name. Use 'SHARED' for global memory; any other wing is private to the current profile." },
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
        if (!query || !isEmbeddingsUnavailableError(error)) throw error
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
    description: "Inspect persisted session evidence before answering questions about what happened, what was said, which tools/workers ran, or where a prior conclusion came from.",
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
      const messageLimit = Math.max(1, Math.min(12, optionalNumber(input, "messageLimit") ?? 6))
      const worklogLimit = Math.max(1, Math.min(20, optionalNumber(input, "worklogLimit") ?? 8))
      const eventLimit = Math.max(1, Math.min(30, optionalNumber(input, "eventLimit") ?? 12))
      const session = pickForensicsSession(context.rootDir, context.profileId, requestedSessionId)
      const events = tailEvents(context.rootDir, session.id, eventLimit)
      const recentMessages = session.messages.slice(-messageLimit)
      const recentWorklog = session.worklog.slice(-worklogLimit)
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
    description: "Delegate a mission to a worker agent. Workers can run in parallel and report back autonomously. Use this for research, implementation, or verification.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", description: "The ID of the profile to use (e.g. 'coder', 'researcher')." },
        task: { type: "string", description: "The specific instructions for the agent." },
        description: { type: "string", description: "A brief name for this task (e.g. 'Fix auth bug')." },
        type: { type: "string", enum: ["worker", "researcher", "verifier"], description: "The specialization level of the agent." },
        isolation: { type: "string", enum: ["none", "worktree"], description: "Use worktree for isolated filesystem access." },
      },
      required: ["profileId", "task"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const profileId = requireString(input, "profileId")
      const task = requireString(input, "task")
      const description = optionalString(input, "description")
      const type = (optionalString(input, "type") as any) || "worker"
      const isolation = (optionalString(input, "isolation") as "none" | "worktree" | undefined) || "none"
      
      if (!context.orchestrator) throw new Error("Agent Orchestrator not available.")

      const parentSessionId = (context as any).sessionId
      if (!parentSessionId) throw new Error("Parent Session ID not found.")
      if (parentSessionId.startsWith("agent-")) {
        throw new Error("Los sub-agentes no pueden spawnear otros agentes. Ejecutá la tarea directamente y devolvé los resultados.")
      }

      const spawned = await context.orchestrator.spawnAgent(parentSessionId, profileId, task, description, type, { isolation })
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
    description: "List worker/sub-agent state for the current parent session so the coordinator can verify whether they are still running or already finished.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(_input, context) {
      if (!context.orchestrator) throw new Error("Agent Orchestrator not available.")
      const parentSessionId = (context as any).sessionId
      if (!parentSessionId) throw new Error("Parent Session ID not found.")
      return {
        ok: true,
        workers: context.orchestrator.getTaskSnapshot(parentSessionId),
      }
    },
  },
  {
    name: "delegate_background_task",
    permissionTier: "edit",
    description: "Use this tool autonomously and proactively for high cognitive load tasks (multiple web searches, deep reading, long analysis, multi-step research) to avoid blocking the chat. You do not need to specify an output file: when the worker finishes, its raw result is injected directly into your volatile memory as a system message and the runtime will force a new inference turn so you can synthesize and respond to the user. Return a short natural acknowledgement to the user immediately (e.g. 'Ahí me pongo, dame un rato') after calling this tool. IMPORTANT: Only the primary coordinator may call this tool. Sub-agents running as background workers must NEVER call delegate_background_task — they must execute their task directly and return results.",
    inputSchema: {
      type: "object",
      properties: {
        task_instruction: { type: "string", description: "Detailed instructions for the background worker." },
        description: { type: "string", description: "Short label for this task." },
        profileId: { type: "string", description: "Optional profile to run the worker under." },
      },
      required: ["task_instruction"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const task = requireString(input, "task_instruction")
      const description = optionalString(input, "description")
      const profileId = optionalString(input, "profileId") ?? context.profileId ?? "default"

      if (!context.orchestrator) throw new Error("Agent Orchestrator not available.")
      const parentSessionId = (context as any).sessionId
      if (!parentSessionId) throw new Error("Parent Session ID not found.")
      if (parentSessionId.startsWith("agent-")) {
        throw new Error("Los sub-agentes no pueden delegar tareas en background. Ejecutá la tarea directamente y devolvé los resultados.")
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

      const jobGroupId = context.runtime?.acquireJobGroupForBatch(parentSessionId)
      const spawned = await context.orchestrator.spawnBackgroundTask(parentSessionId, profileId, task, description, jobGroupId)
      return {
        ok: spawned.status !== "failed" && spawned.status !== "killed",
        job_id: spawned.agentId,
        status: spawned.status,
        result: spawned.result ?? "",
        error: spawned.error,
        message: spawned.status === "spawned"
          ? "Background worker started. You will be notified when it completes."
          : "Background worker finished immediately.",
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
      if (!context.orchestrator) throw new Error("Agent Orchestrator not available.")
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
      if (!context.orchestrator) throw new Error("Agent Orchestrator not available.")
      await context.orchestrator.stopAgent(agentId)
      return { ok: true, message: `Agent ${agentId} stopped.` }
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
    description: "Search for images on the internet via SearxNG. Auto-deploys SearxNG Docker container if not running (localhost only). Returns image URLs. ATENCIÓN: Si el flujo implica buscar imágenes Y luego analizarlas visualmente con AnalyzeImage (validación, filtrado, procesamiento de una o más imágenes), ese trabajo combinado supera el límite de tiempo del turno principal. En ese caso DEBÉS delegar todo el flujo a un sub-agente usando delegate_background_task y avisarle al usuario que estás procesando en background.",
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
    async run(input) {
      const query = requireString(input, "query")
      const limit = optionalNumber(input, "limit") ?? 5
      const deploy = await deploySearxng()
      if (!deploy.ok) throw new Error(`Error auto-desplegando SearxNG: ${deploy.message}`)

      // 3. Search
      const encoded = encodeURIComponent(query)
      const searchUrl = `${SEARXNG_URL}/search?q=${encoded}&categories=images&format=json`
      try {
        const res = await fetch(searchUrl, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) {
          return { ok: false, error: `SearxNG returned HTTP ${res.status}` }
        }
        const data = await res.json()
        const results = objectArrayField(data, "results")
          .filter(r => typeof r.img_src === "string" && r.img_src.length > 0)
          .slice(0, limit)
          .map(r => ({
            url: r.img_src,
            title: typeof r.title === "string" ? r.title : undefined,
            source: typeof r.source === "string" ? r.source : undefined,
            thumbnail: typeof r.thumbnail_src === "string" ? r.thumbnail_src : undefined,
          }))

        return { ok: true, query, count: results.length, results }
      } catch (searchErr) {
        const msg = searchErr instanceof Error ? searchErr.message : String(searchErr)
        return { ok: false, error: `Search failed: ${msg}` }
      }
    },
  },
  {
    name: "AnalyzeImage",
    permissionTier: "read",
    description: "Descarga una imagen de una URL, la analiza con visión local y devuelve la descripción visual junto con la ruta local del archivo (local_path). Ideal para validar empíricamente resultados de ImageSearch y obtener el archivo local para enviarlo vía TelegramSendPhoto. ATENCIÓN: Herramienta computacionalmente pesada (~60s por imagen). REGLA ESTRICTA: NO uses esta herramienta en la sesión principal bajo ninguna circunstancia. Para cualquier análisis visual (incluso una sola foto), DEBÉS invocar delegate_background_task para hacer este trabajo en background y avisarle al usuario inmediatamente.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => typeof input.url === "string" && input.url.trim().length > 0 ? null : "url must be a non-empty string",
    async run(input, context) {
      const url = requireString(input, "url")
      const config = readChannelsConfig()
      const vision = normalizeVisionConfig(config.vision)
      if (!vision.managed) {
        throw new Error("La visión local no está habilitada en la configuración.")
      }

      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        throw new Error(`Image download failed: HTTP ${response.status}`)
      }

      const scratchpadDir = join(context.rootDir, ".monolito-v2", "scratchpad")
      mkdirSync(scratchpadDir, { recursive: true })
      const tmpPath = join(scratchpadDir, `vision-${randomUUID()}.jpg`)
      const buffer = Buffer.from(await response.arrayBuffer())
      writeFileSync(tmpPath, buffer)

      const description = await analyzeManagedImage(tmpPath, vision)
      return { ok: true, description, local_path: tmpPath }
    },
  },
  {
    name: "WebSearch",
    permissionTier: "read",
    description: "Search the web for current text results via the local SearxNG instance and return clean summaries with title, URL, and snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input) {
      const query = requireString(input, "query")
      const deploy = await deploySearxng()
      if (!deploy.ok) throw new Error(`Error auto-desplegando SearxNG: ${deploy.message}`)
      const searchUrl = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`

      try {
        const response = await fetch(searchUrl, { signal: AbortSignal.timeout(15_000) })
        if (!response.ok) {
          return { ok: false, error: `SearxNG returned HTTP ${response.status}` }
        }

        const data = await response.json()
        const results = objectArrayField(data, "results")
          .filter(result => typeof result.url === "string" && result.url.length > 0)
          .slice(0, 8)
          .map(result => ({
            title: compactWhitespace(typeof result.title === "string" ? result.title : "Untitled result"),
            url: result.url ?? "",
            snippet: compactWhitespace(typeof result.content === "string" ? result.content : ""),
          }))

        const formatted = results.length === 0
          ? "No results found."
          : results
            .map((result, index) => {
              const snippet = result.snippet ? `\n${truncateText(result.snippet, 280)}` : ""
              return `${index + 1}. ${result.title}\n${result.url}${snippet}`
            })
            .join("\n\n")

        return { ok: true, query, count: results.length, results, formatted }
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
    description: "Read or update technical configuration stored in SQLite CONF_* wings. Use this instead of reading or writing JSON config files manually. IMPORTANTE al actualizar CONF_CHANNELS: No colocar las credenciales en la raíz. Anidar siempre bajo la clave del canal correspondiente, por ejemplo: { 'telegram': { 'bot_token': '...' } }.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write"] },
        wing: { type: "string", enum: [...CONFIG_WING_ORDER] },
        value: {},
      },
      required: ["action", "wing"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    async run(input, context) {
      const action = requireString(input, "action") as "read" | "write"
      const wing = requireString(input, "wing") as ConfigWingName
      if (action === "read") {
        return { wing, value: redactSensitiveValue(readConfigWing(context.rootDir, wing)) }
      }
      const value = parseJsonStringValue(input.value)
      if (value === undefined) throw new Error("value is required when action='write'")
      const normalizedValue = normalizeConfigWingValue(wing, value)
      const result = writeConfigWing(context.rootDir, wing, normalizedValue as never)
      if (wing === "CONF_SYSTEM" || wing === "CONF_MODELS") {
        loadAndApplyModelSettings(process.env)
      }
      appendActionLog(context.rootDir, "Configuracion tecnica modificada", {
        wing,
        changed: result.changed,
      })
      return {
        wing,
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
]

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

export function listModelTools(isSubAgent = false) {
  const hiddenFromSubAgents = new Set([
    "AgentSpawn",
    "AgentSendMessage",
    "AgentStop",
    "delegate_background_task",
    "list_active_workers"
  ])

  return tools
    .filter(tool => !(isSubAgent && hiddenFromSubAgents.has(tool.name)))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))
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
