/**
 * Structured error types and utilities for Monolito V2.
 * Adapted from Free Code's error infrastructure for robust error handling.
 */

export class MonolitoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }
}

export class AbortError extends MonolitoError {
  constructor(message = "Operation aborted") {
    super(message)
    this.name = "AbortError"
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof AbortError || (error instanceof Error && error.name === "AbortError")
}

export class SessionBusyError extends MonolitoError {
  readonly code = "SESSION_BUSY"
  constructor(sessionId: string) {
    super(`La sesión ${sessionId} ya está ocupada por otro turno en ejecución.`)
    this.name = "SessionBusyError"
  }
}

export function getRetryAfterMsFromHeaders(headers?: Headers | null): number | null {
  const retryAfter = headers?.get("retry-after")
  if (!retryAfter) return null
  const seconds = Number.parseInt(retryAfter, 10)
  if (Number.isFinite(seconds)) return seconds * 1000
  const dateMs = Date.parse(retryAfter)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
  return null
}

type HttpErrorOptions = {
  statusCode?: number
  responseBody?: string
  headers?: Headers | null
}

export class HttpError extends MonolitoError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: string,
    public readonly headers?: Headers | null,
  ) {
    super(message)
    this.name = "HttpError"
  }
}

export class RateLimitError extends HttpError {
  readonly retryAfterMs: number | null

  constructor(message: string, options: HttpErrorOptions = {}) {
    super(message, options.statusCode ?? 429, options.responseBody, options.headers)
    this.name = "RateLimitError"
    this.retryAfterMs = getRetryAfterMsFromHeaders(options.headers)
  }
}

type ContextOverflowOptions = HttpErrorOptions & {
  maxTokens?: number
  inputTokens?: number
  overflowAmount?: number
}

export class ContextOverflowError extends HttpError {
  readonly maxTokens?: number
  readonly inputTokens?: number
  readonly overflowAmount?: number

  constructor(message: string, options: ContextOverflowOptions = {}) {
    super(message, options.statusCode ?? 400, options.responseBody, options.headers)
    this.name = "ContextOverflowError"
    this.maxTokens = options.maxTokens
    this.inputTokens = options.inputTokens
    this.overflowAmount = options.overflowAmount
  }
}

export class ToolExecutionError extends MonolitoError {
  constructor(
    message: string,
    public readonly command?: string,
    public readonly exitCode?: number | null,
    public readonly stdout = "",
    public readonly stderr = "",
    public readonly output?: unknown,
  ) {
    super(message)
    this.name = "ToolExecutionError"
  }
}

export class ProviderOverloadedError extends HttpError {
  constructor(message: string, options: HttpErrorOptions = {}) {
    super(message, options.statusCode, options.responseBody, options.headers)
    this.name = "ProviderOverloadedError"
  }
}

export class ShellError extends MonolitoError {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: number,
    public readonly interrupted: boolean,
  ) {
    super("Shell command failed")
    this.name = "ShellError"
  }
}

export class ConfigParseError extends MonolitoError {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly defaultConfig: unknown,
  ) {
    super(message)
    this.name = "ConfigParseError"
  }
}

export class ApiError extends MonolitoError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export class TimeoutError extends MonolitoError {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message)
    this.name = "TimeoutError"
  }
}

// --- Utility functions ---

/** Normalize unknown value into an Error instance. */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Extract string message from unknown error-like value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Extract errno code (e.g. 'ENOENT', 'EACCES') from a caught error. */
export function getErrnoCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof (error as Record<string, unknown>).code === "string") {
    return (error as Record<string, unknown>).code as string
  }
  return undefined
}

/** True if the error is ENOENT (file/directory does not exist). */
export function isENOENT(error: unknown): boolean {
  return getErrnoCode(error) === "ENOENT"
}

/**
 * True if the error means the path is missing, inaccessible, or structurally unreachable.
 * Covers: ENOENT, EACCES, EPERM, ENOTDIR, ELOOP.
 */
export function isFsInaccessible(error: unknown): boolean {
  const code = getErrnoCode(error)
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR" || code === "ELOOP"
}

/** True if the error is a network/socket error that can be safely ignored. */
export function isIgnorableSocketError(error: unknown): boolean {
  const code = getErrnoCode(error)
  return code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED"
}

/**
 * Extract error message + top N stack frames.
 * Full stack traces waste context tokens in tool results.
 */
export function shortErrorStack(error: unknown, maxFrames = 5): string {
  if (!(error instanceof Error)) return String(error)
  if (!error.stack) return error.message
  const lines = error.stack.split("\n")
  const header = lines[0] ?? error.message
  const frames = lines.slice(1).filter(line => line.trim().startsWith("at "))
  if (frames.length <= maxFrames) return error.stack
  return [header, ...frames.slice(0, maxFrames)].join("\n")
}

/** Classify an HTTP fetch error into a bucket. */
export type HttpErrorKind = "auth" | "timeout" | "network" | "http" | "other"

export function classifyHttpError(error: unknown): { kind: HttpErrorKind; status?: number; message: string } {
  const message = errorMessage(error)
  if (error instanceof HttpError) {
    if (error.statusCode === 401 || error.statusCode === 403) return { kind: "auth", status: error.statusCode, message }
    return { kind: "http", status: error.statusCode, message }
  }
  if (error instanceof ApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) return { kind: "auth", status: error.statusCode, message }
    return { kind: "http", status: error.statusCode, message }
  }
  const code = getErrnoCode(error)
  if (code === "ECONNABORTED" || error instanceof TimeoutError) return { kind: "timeout", message }
  if (code === "ECONNREFUSED" || code === "ENOTFOUND") return { kind: "network", message }
  return { kind: "other", message }
}
