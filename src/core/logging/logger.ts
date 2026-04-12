/**
 * Structured logging for Monolito V2.
 * Categories, timestamps, in-memory error buffer, and file sinks.
 */

import { appendFileSync, createWriteStream, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { MONOLITO_ROOT } from "../system/root.ts"

export type LogLevel = "debug" | "info" | "warn" | "error"

export type LogEntry = {
  timestamp: string
  level: LogLevel
  category: string
  message: string
  data?: Record<string, unknown>
  durationMs?: number
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

const inMemoryErrors: LogEntry[] = []
const sinks: LogSink[] = []
let minLevel: LogLevel = "info"

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel]
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

function formatEntry(entry: LogEntry): string {
  const parts = [entry.timestamp, `[${entry.level.toUpperCase()}]`, `[${entry.category}]`, entry.message]
  if (entry.durationMs !== undefined) parts.push(`(${entry.durationMs}ms)`)
  if (entry.data) {
    const data = Object.entries(entry.data)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ")
    if (data) parts.push(data)
  }
  return parts.join(" ")
}

function emit(entry: LogEntry) {
  if (!shouldLog(entry.level)) return
  if (entry.level === "error") {
    if (inMemoryErrors.length >= MAX_IN_MEMORY_ERRORS) inMemoryErrors.shift()
    inMemoryErrors.push(entry)
  }
  for (const sink of sinks) {
    try {
      sink(entry)
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
  return (entry: LogEntry) => {
    appendFileSync(filePath, `${formatEntry(entry)}\n`)
  }
}

export function getRecentErrors(): ReadonlyArray<LogEntry> {
  return inMemoryErrors
}

export function clearRecentErrors() {
  inMemoryErrors.length = 0
}

export function log(level: LogLevel, category: string, message: string, data?: unknown, durationMs?: number) {
  emit({
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    data: normalizeLogData(data),
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

/** Log with timing: returns a function that logs the elapsed time when called. */
export function logTimed(level: LogLevel, category: string, message: string, data?: unknown) {
  const start = Date.now()
  return (extraData?: Record<string, unknown>) => {
    const base = normalizeLogData(data) ?? {}
    log(level, category, message, { ...base, ...extraData }, Date.now() - start)
  }
}

/** Create a scoped logger for a specific category. */
export function createLogger(category: string) {
  return {
    debug: (message: string, data?: unknown) => logDebug(category, message, data),
    info: (message: string, data?: unknown) => logInfo(category, message, data),
    warn: (message: string, data?: unknown) => logWarn(category, message, data),
    error: (message: string, data?: unknown) => logError(category, message, data),
    timed: (level: LogLevel, message: string, data?: unknown) => logTimed(level, category, message, data),
  } satisfies Logger
}

export function createInstanceLogger(agentId: string, role: string): Logger {
  const logPath = join(MONOLITO_ROOT, "logs", "instances", `${role}-${agentId}.log`)
  mkdirSync(dirname(logPath), { recursive: true })
  const stream = createWriteStream(logPath, { flags: "a" })
  const writeLine = (line: string) => {
    stream.write(line.endsWith("\n") ? line : `${line}\n`)
  }
  const emitInstance = (entry: LogEntry) => writeLine(formatEntry(entry))

  const logInstance = (level: LogLevel, category: string, message: string, data?: unknown, durationMs?: number) => {
    emitInstance({
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data: normalizeLogData(data),
      durationMs,
    })
  }

  return {
    debug: (message: string, data?: unknown) => logInstance("debug", role, message, data),
    info: (message: string, data?: unknown) => logInstance("info", role, message, data),
    warn: (message: string, data?: unknown) => logInstance("warn", role, message, data),
    error: (message: string, data?: unknown) => logInstance("error", role, message, data),
    timed: (level: LogLevel, message: string, data?: unknown) => {
      const start = Date.now()
      return (extraData?: Record<string, unknown>) => {
        const base = normalizeLogData(data) ?? {}
        logInstance(level, role, message, { ...base, ...extraData }, Date.now() - start)
      }
    },
    writeRaw: (text: string) => {
      if (!text) return
      stream.write(text)
    },
    logPath,
  }
}
