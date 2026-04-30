/**
 * Structured JSONL logging for Monolito V2.
 * - Pure JSONL output (one JSON object per line)
 * - AsyncLocalStorage for automatic session_id/agent_id injection
 * - File rotation (size-based and daily)
 * - Separation: conversational history → SQLite, technical audit → JSONL logs
 */

import { appendFileSync, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import { MONOLITO_ROOT } from "../system/root.ts"

export type LogLevel = "debug" | "info" | "warn" | "error"

export type LogContext = {
  sessionId?: string
  agentId?: string
}

export type LogEntry = {
  timestamp: string
  level: LogLevel
  category: string
  message: string
  session_id?: string
  agent_id?: string
  data?: Record<string, unknown>
  durationMs?: number
  errorName?: string
  errorMessage?: string
  errorStack?: string
}

type LogSink = (entry: LogEntry) => void

export type Logger = {
  debug: (message: string, data?: unknown) => void
  info: (message: string, data?: unknown) => void
  warn: (message: string, data?: unknown) => void
  error: (message: string, data?: unknown) => void
  timed: (level: LogLevel, message: string, data?: unknown) => (extraData?: Record<string, unknown>) => void
  writeRaw?: (text: string) => void
  logPath?: string
}

const MAX_IN_MEMORY_ERRORS = 100
const MAX_LOG_FILE_SIZE_BYTES = 50 * 1024 * 1024 // 50MB

const inMemoryErrors: LogEntry[] = []
const sinks: LogSink[] = []
let minLevel: LogLevel = "info"

const contextStorage = new AsyncLocalStorage<LogContext>()

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel]
}

function getCurrentContext(): LogContext {
  return contextStorage.getStore() ?? {}
}

function normalizeLogData(data: unknown): Record<string, unknown> | undefined {
  if (data === undefined) return undefined
  if (data instanceof Error) {
    return {
      errorName: data.name,
      errorMessage: data.message,
      ...(data.stack ? { errorStack: data.stack } : {}),
      ...Object.fromEntries(Object.entries(data)),
    }
  }
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    return data as Record<string, unknown>
  }
  return { value: data }
}

function serializeEntry(entry: LogEntry): string {
  return JSON.stringify(entry)
}

function emit(entry: LogEntry) {
  if (!shouldLog(entry.level)) return

  const ctx = getCurrentContext()
  const entryWithContext: LogEntry = {
    ...entry,
    session_id: entry.session_id ?? ctx.sessionId,
    agent_id: entry.agent_id ?? ctx.agentId,
  }

  if (entryWithContext.level === "error") {
    if (inMemoryErrors.length >= MAX_IN_MEMORY_ERRORS) inMemoryErrors.shift()
    inMemoryErrors.push(entryWithContext)
  }
  for (const sink of sinks) {
    try {
      sink(entryWithContext)
    } catch {}
  }
}

// --- Public API ---

export function setLogLevel(level: LogLevel) {
  minLevel = level
}

export function addLogSink(sink: LogSink) {
  sinks.push(sink)
  return () => {
    const index = sinks.indexOf(sink)
    if (index >= 0) sinks.splice(index, 1)
  }
}

export function createFileSink(filePath: string): LogSink {
  mkdirSync(dirname(filePath), { recursive: true })
  let stream = createWriteStream(filePath, { flags: "a" })
  let currentFileSize = existsSync(filePath) ? statSync(filePath).size : 0

  const rotateIfNeeded = () => {
    if (currentFileSize >= MAX_LOG_FILE_SIZE_BYTES) {
      stream.end()
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      const rotatedPath = `${filePath}.${timestamp}`
      try {
        const dir = dirname(filePath)
        const base = require("path").basename(filePath)
        const rotatedName = `${base}.${timestamp}`
        const rotatedFullPath = join(dir, rotatedName)
        stream = createWriteStream(rotatedFullPath, { flags: "a" })
        currentFileSize = 0
      } catch {
        stream = createWriteStream(filePath, { flags: "a" })
        currentFileSize = 0
      }
    }
  }

  return (entry: LogEntry) => {
    const line = `${serializeEntry(entry)}\n`
    stream.write(line)
    currentFileSize += Buffer.byteLength(line, "utf8")
    rotateIfNeeded()
  }
}

export function createDailyRotatingFileSink(filePath: string): LogSink {
  mkdirSync(dirname(filePath), { recursive: true })
  let currentDate = new Date().toISOString().slice(0, 10)

  const getDailyFilePath = (base: string, date: string) => {
    const baseName = base.replace(/\.log$/, "")
    return `${baseName}.${date}.log`
  }

  let stream = createWriteStream(getDailyFilePath(filePath, currentDate), { flags: "a" })

  const rotateIfNeeded = () => {
    const today = new Date().toISOString().slice(0, 10)
    if (today !== currentDate) {
      stream.end()
      currentDate = today
      stream = createWriteStream(getDailyFilePath(filePath, currentDate), { flags: "a" })
    }
  }

  return (entry: LogEntry) => {
    rotateIfNeeded()
    const line = `${serializeEntry(entry)}\n`
    stream.write(line)
  }
}

export function getRecentErrors(): ReadonlyArray<LogEntry> {
  return inMemoryErrors
}

export function clearRecentErrors() {
  inMemoryErrors.length = 0
}

export function log(level: LogLevel, category: string, message: string, data?: unknown, durationMs?: number) {
  const normalizedData = normalizeLogData(data)
  emit({
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    data: normalizedData,
    durationMs,
  })
}

export function logDebug(category: string, message: string, data?: unknown) {
  log("debug", category, message, data)
}

export function logInfo(category: string, message: string, data?: unknown) {
  log("info", category, message, data)
}

export function logWarn(category: string, message: string, data?: unknown) {
  log("warn", category, message, data)
}

export function logError(category: string, message: string, data?: unknown) {
  log("error", category, message, data)
}

export function logTimed(level: LogLevel, category: string, message: string, data?: unknown) {
  const start = Date.now()
  return (extraData?: Record<string, unknown>) => {
    const base = normalizeLogData(data) ?? {}
    log(level, category, message, { ...base, ...extraData }, Date.now() - start)
  }
}

export function createLogger(category: string) {
  return {
    debug: (message: string, data?: unknown) => logDebug(category, message, data),
    info: (message: string, data?: unknown) => logInfo(category, message, data),
    warn: (message: string, data?: unknown) => logWarn(category, message, data),
    error: (message: string, data?: unknown) => logError(category, message, data),
    timed: (level: LogLevel, message: string, data?: unknown) => logTimed(level, category, message, data),
  } satisfies Logger
}

export function createContextLogger(category: string) {
  return {
    debug: (message: string, data?: unknown) => {
      const ctx = getCurrentContext()
      log("debug", category, message, { ...ctx, ...normalizeLogData(data) })
    },
    info: (message: string, data?: unknown) => {
      const ctx = getCurrentContext()
      log("info", category, message, { ...ctx, ...normalizeLogData(data) })
    },
    warn: (message: string, data?: unknown) => {
      const ctx = getCurrentContext()
      log("warn", category, message, { ...ctx, ...normalizeLogData(data) })
    },
    error: (message: string, data?: unknown) => {
      const ctx = getCurrentContext()
      log("error", category, message, { ...ctx, ...normalizeLogData(data) })
    },
    timed: (level: LogLevel, message: string, data?: unknown) => {
      const ctx = getCurrentContext()
      const start = Date.now()
      return (extraData?: Record<string, unknown>) => {
        log(level, category, message, { ...ctx, ...normalizeLogData(data), ...extraData }, Date.now() - start)
      }
    },
  } satisfies Logger
}

export function createInstanceLogger(agentId: string, role: string, traceId?: string): Logger {
  const logsDir = join(MONOLITO_ROOT, "logs", "instances")
  mkdirSync(logsDir, { recursive: true })
  const logPath = join(logsDir, `${role}-${agentId}.log`)
  const stream = createWriteStream(logPath, { flags: "a" })

  return {
    debug: (message: string, data?: unknown) => {
      const ctx = getCurrentContext()
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "debug",
        category: role,
        message,
        agent_id: agentId,
        session_id: ctx.sessionId,
        data: normalizeLogData(data),
      }
      stream.write(`${serializeEntry(entry)}\n`)
    },
    info: (message: string, data?: unknown) => {
      const ctx = getCurrentContext()
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "info",
        category: role,
        message,
        agent_id: agentId,
        session_id: ctx.sessionId,
        data: normalizeLogData(data),
      }
      stream.write(`${serializeEntry(entry)}\n`)
    },
    warn: (message: string, data?: unknown) => {
      const ctx = getCurrentContext()
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "warn",
        category: role,
        message,
        agent_id: agentId,
        session_id: ctx.sessionId,
        data: normalizeLogData(data),
      }
      stream.write(`${serializeEntry(entry)}\n`)
    },
    error: (message: string, data?: unknown) => {
      const ctx = getCurrentContext()
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "error",
        category: role,
        message,
        agent_id: agentId,
        session_id: ctx.sessionId,
        data: normalizeLogData(data),
      }
      stream.write(`${serializeEntry(entry)}\n`)
    },
    timed: (level: LogLevel, message: string, data?: unknown) => {
      const start = Date.now()
      return (extraData?: Record<string, unknown>) => {
        const ctx = getCurrentContext()
        const normalizedData = normalizeLogData(data) ?? {}
        const entry: LogEntry = {
          timestamp: new Date().toISOString(),
          level,
          category: role,
          message,
          agent_id: agentId,
          session_id: ctx.sessionId,
          data: { ...normalizedData, ...extraData },
          durationMs: Date.now() - start,
        }
        stream.write(`${serializeEntry(entry)}\n`)
      }
    },
    writeRaw: (text: string) => {
      if (!text) return
      stream.write(text.endsWith("\n") ? text : `${text}\n`)
    },
    logPath,
  }
}

export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return contextStorage.run(context, fn)
}

export function getContext(): LogContext {
  return getCurrentContext()
}

export function createSessionContext(sessionId: string) {
  return { sessionId }
}

export function createAgentContext(agentId: string, sessionId?: string) {
  return { agentId, sessionId }
}
