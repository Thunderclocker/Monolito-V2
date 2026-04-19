import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SessionRecord } from "../ipc/protocol.ts"
import { ensureDirs } from "../ipc/protocol.ts"
import { type ToolContext, isToolConcurrencySafe, listModelTools, validateToolInput } from "../tools/registry.ts"
import { type ToolCallDirective, parseDirective } from "./directiveParser.ts"
import { readModelSettings, refreshModelAuth } from "./modelConfig.ts"
import { getActiveProfile, type ModelProvider } from "./modelRegistry.ts"
import { readChannelsConfig } from "../channels/config.ts"
import type { WebSearchProvider } from "../websearch/config.ts"
import { type CostState, type TurnUsage, createCostState, recordApiCall } from "../cost/tracker.ts"
import { getDateContext, getGitContext } from "../context/gitContext.ts"
import { createLogger, type Logger } from "../logging/logger.ts"
import { COORDINATOR_SYSTEM_PROMPT, WORKER_SYSTEM_PROMPT } from "./coordinatorPrompt.ts"
import type { WorkspaceBootstrapContext } from "../context/workspaceContext.ts"
import { BOOT_WING_DESCRIPTION, type BootWingEntry } from "../bootstrap/bootWings.ts"
import { normalizeToolInputPayload } from "./toolInput.ts"
import { ContextOverflowError, ProviderOverloadedError, RateLimitError } from "../errors.ts"

const defaultLogger = createLogger("modelAdapter")

function getLogger(context?: ToolContext): Logger {
  return context?.logger ?? defaultLogger
}

type AnthropicMessage = {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

type AnthropicTextBlock = {
  type: "text"
  text: string
}

type AnthropicToolUseBlock = {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

type AnthropicToolResultBlock = {
  type: "tool_result"
  tool_use_id: string
  content: string
  is_error?: boolean
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock

type AnthropicResponse = {
  content?: Array<
    | { type: "text"; text?: string }
    | { type: "thinking"; thinking?: string }
    | { type: "tool_use"; id?: string; name?: string; input?: unknown }
    | { type: string; [key: string]: unknown }
  >
  stop_reason?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

type ResponseTextBlock = Extract<NonNullable<AnthropicResponse["content"]>[number], { type: "text" }>
type ResponseThinkingBlock = Extract<NonNullable<AnthropicResponse["content"]>[number], { type: "thinking" }>
type ResponseToolUseBlock = Extract<NonNullable<AnthropicResponse["content"]>[number], { type: "tool_use" }>

function isAssistantRole(role: string): role is AnthropicMessage["role"] {
  return role === "user" || role === "assistant"
}

function isResponseTextBlock(block: NonNullable<AnthropicResponse["content"]>[number]): block is ResponseTextBlock {
  return block.type === "text"
}

function isResponseThinkingBlock(block: NonNullable<AnthropicResponse["content"]>[number]): block is ResponseThinkingBlock {
  return block.type === "thinking"
}

function isResponseToolUseBlock(block: NonNullable<AnthropicResponse["content"]>[number]): block is ResponseToolUseBlock {
  return block.type === "tool_use"
}

export type AssistantTurnStep =
  | { type: "tool"; id?: string; tool: string; input: Record<string, unknown> }
  | { type: "final"; message: string }

export type AssistantTurnResult = {
  finalText: string
  steps: AssistantTurnStep[]
  error?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  meta?: {
    iterationCount: number
    durationMs: number
    stopReason?: "completed" | "max_iterations" | "max_duration" | "aborted"
  }
}

type AssistantTurnEvent =
  | { type: "response"; response: AnthropicResponse }
  | { type: "tool_results"; records: ToolExecutionRecord[]; responseUsage?: AssistantTurnResult["usage"] }
  | { type: "recoverable_error"; error: string }
  | { type: "final"; result: AssistantTurnResult }

type TurnLoopState = {
  rootDir: string
  executeTool: (tool: string, input: Record<string, unknown>, context: ToolContext, toolUseId?: string) => Promise<unknown>
  context: ToolContext
  logger: Logger
  abortSignal?: AbortSignal
  baseMessages: AnthropicMessage[]
  system: SystemPrompt
  steps: AssistantTurnStep[]
  toolMessages: AnthropicMessage[]
  lastUserMessage: string
  needsFreshLocalTool: boolean
  attemptedCommands: Map<string, number>
  rejectedFinals: Map<string, number>
  toolEvidence: ToolExecutionRecord[]
  retryPolicy: RetryPolicy
  iterationCount: number
  turnStartedAt: number
  maxTurnDurationMs: number
}

type ToolExecutionRecord = {
  id: string
  tool: string
  input: Record<string, unknown>
  output: unknown
  error?: string
}

type RecoveryInterceptorState<M = unknown> = {
  provider: ModelProvider
  rootDir: string
  requestMessages: M[]
  maxTokens: number
  retryPolicy: RetryPolicy
  abortSignal?: AbortSignal
}

type RecoveryInterceptorHandlers<T, M = unknown> = {
  execute: (state: RecoveryInterceptorState<M>, attempt: number) => Promise<T>
  onContextOverflow?: (state: RecoveryInterceptorState<M>, error: ContextOverflowError, attempt: number) => Promise<RecoveryInterceptorState<M>> | RecoveryInterceptorState<M>
  onRateLimit?: (state: RecoveryInterceptorState<M>, error: RateLimitError, attempt: number) => Promise<void> | void
  onProviderOverloaded?: (state: RecoveryInterceptorState<M>, error: ProviderOverloadedError, attempt: number) => Promise<void> | void
  maxAttempts?: number
}

async function withRecoveryInterceptor<T, M = unknown>(
  initialState: RecoveryInterceptorState<M>,
  handlers: RecoveryInterceptorHandlers<T, M>,
): Promise<T> {
  let state = initialState
  const persistent = isUnattendedRetryEnabled(initialState.retryPolicy)
  const heartbeat = persistent ? () => touchHeartbeatFile(initialState.rootDir) : null
  const maxAttempts = handlers.maxAttempts ?? (persistent ? PERSISTENT_MAX_ATTEMPTS : 6)
  let attempt = 0

  while (attempt < maxAttempts) {
    if (fastModeCooldownUntil > Date.now()) {
      await sleepWithHeartbeat(Math.min(fastModeCooldownUntil - Date.now(), 5_000), state.abortSignal, heartbeat)
    }

    try {
      return await handlers.execute(state, attempt)
    } catch (error) {
      if (error instanceof ContextOverflowError && handlers.onContextOverflow) {
        attempt += 1
        state = await handlers.onContextOverflow(state, error, attempt)
        continue
      }
      if (error instanceof RateLimitError) {
        attempt += 1
        await handlers.onRateLimit?.(state, error, attempt)
        const delayMs = error.retryAfterMs ?? computeBackoffMs(attempt - 1, null, persistent ? PERSISTENT_MAX_BACKOFF_MS : 32_000)
        if (fastModeCooldownUntil !== Number.POSITIVE_INFINITY) {
          fastModeCooldownUntil = Math.max(fastModeCooldownUntil, Date.now() + delayMs)
        }
        await sleepWithHeartbeat(delayMs, state.abortSignal, heartbeat)
        continue
      }
      if (error instanceof ProviderOverloadedError) {
        attempt += 1
        await handlers.onProviderOverloaded?.(state, error, attempt)
        const delayMs = computeBackoffMs(attempt - 1, null, persistent ? PERSISTENT_MAX_BACKOFF_MS : 32_000)
        await sleepWithHeartbeat(delayMs, state.abortSignal, heartbeat)
        continue
      }
      throw error
    }
  }

  throw new Error(`Recovery interceptor exhausted after ${Number.isFinite(maxAttempts) ? maxAttempts : "many"} attempts for ${initialState.provider}`)
}

type InternalToolUse = {
  id: string
  tool: string
  input: Record<string, unknown>
}

const MAX_INLINE_TOOL_RESULT_CHARS = 20_000
const MAX_REPEATED_BASH_COMMANDS = 2
const MAX_REJECTED_REPEATED_BASH_COMMANDS = 4
const MAX_REJECTED_FINAL_REPEATS = 2
const MAX_OPERATIONAL_TOOL_STEPS = 8
const PROTECTED_TAIL_MESSAGES = 12
const MAX_HISTORY_MESSAGES_BEFORE_COMPACT = 20
const SNIP_TEXT_LIMIT = 900
const MAX_COMPACT_SUMMARY_BLOCKS = 8
const MAX_TURN_ITERATIONS = 16
const MAX_TURN_DURATION_MS = 120_000
const SHORT_RETRY_THRESHOLD_MS = 20_000
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000
const RATE_LIMIT_BREAKER_OPEN_MS = 10 * 60 * 1000
const RATE_LIMIT_BREAKER_THRESHOLD = 5
const RATE_LIMIT_ABORT_THRESHOLD = 10
const PERSISTENT_MAX_ATTEMPTS = 30
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_WINDOW_MS = 6 * 60 * 60 * 1000
const PERSISTENT_HEARTBEAT_MS = 30_000
const INTERACTIVE_MODEL_REQUEST_TIMEOUT_MS = 75_000
const BACKGROUND_MODEL_REQUEST_TIMEOUT_MS = 45_000
const MODEL_FAILURE_PREFIXES = [
  "Model request failed:",
  "Network/model error after retries:",
]

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "")
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function isModelFailureText(text: string) {
  const normalized = text.trim()
  return MODEL_FAILURE_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

function selectRecoveryMaxAttempts(retryPolicy: RetryPolicy) {
  if (retryPolicy.background) return 6
  return isUnattendedRetryEnabled(retryPolicy) ? undefined : 6
}

function isTaskNotification(text: string) {
  const normalized = text.trim()
  return normalized.startsWith("<task-notification>") && normalized.endsWith("</task-notification>")
}

function isNonCommittalOperationalReply(text: string) {
  const normalized = compactWhitespace(text).toLowerCase()
  if (!normalized) return false
  return [
    /^(voy a|ya lo|ahora lo|deja(?:me)?|déjame|primero voy a|perm[ií]time|un momento)/,
    /\b(revisar|investigar|verificar|mirar|check|inspect|investigate|review|look into)\b/,
  ].every(pattern => pattern.test(normalized))
}

function shouldSkipMessage(text: string) {
  const normalized = text.trim()
  return (
    normalized.startsWith("/") ||
    normalized === "Status dialog dismissed" ||
    /^(TOOL_USE|TOOL_RESULT|TOOL_CALL_ERROR)\b/.test(normalized)
  )
}

function sessionToAnthropicMessages(session: SessionRecord): AnthropicMessage[] {
  return session.messages
    .filter((message): message is SessionRecord["messages"][number] & { role: AnthropicMessage["role"] } => isAssistantRole(message.role))
    .filter(message => !shouldSkipMessage(message.text))
    .map(message => ({
      role: message.role,
      content: message.text,
    }))
}

function snipMessageContent(text: string) {
  const normalized = text.trim()
  if (normalized.length <= SNIP_TEXT_LIMIT) return normalized
  const head = normalized.slice(0, 320).trimEnd()
  const tail = normalized.slice(-220).trimStart()
  return `${head}\n\n[...snipped ${normalized.length - head.length - tail.length} chars...]\n\n${tail}`
}

function compactHistoryMessages(messages: AnthropicMessage[]) {
  if (messages.length <= MAX_HISTORY_MESSAGES_BEFORE_COMPACT) return messages

  const protectedTail = messages.slice(-PROTECTED_TAIL_MESSAGES)
  const older = messages.slice(0, -PROTECTED_TAIL_MESSAGES).map(message => {
    if (typeof message.content !== "string") return message
    return { ...message, content: snipMessageContent(message.content) }
  })

  const grouped: AnthropicMessage[] = []
  let buffer: AnthropicMessage[] = []

  const flush = () => {
    if (buffer.length === 0) return
    const role = buffer[0]!.role
    const previews = buffer
      .map(item => typeof item.content === "string" ? compactWhitespace(item.content).slice(0, 140) : "")
      .filter(Boolean)
      .slice(-3)
      .map(line => `- ${line}`)
      .join("\n")
    grouped.push({
      role,
      content: [
        `[Earlier ${role} context compacted: ${buffer.length} message${buffer.length === 1 ? "" : "s"}]`,
        previews ? "Recent highlights from that compacted block:" : "",
        previews,
      ].filter(Boolean).join("\n"),
    })
    buffer = []
  }

  for (const message of older) {
    if (buffer.length === 0 || buffer[0]!.role === message.role) {
      buffer.push(message)
    } else {
      flush()
      buffer.push(message)
    }
  }
  flush()

  const compactedOlder = grouped.length > MAX_COMPACT_SUMMARY_BLOCKS
    ? grouped.slice(-MAX_COMPACT_SUMMARY_BLOCKS)
    : grouped

  return [
    ...compactedOlder,
    ...protectedTail,
  ]
}

function extractAssistantText(response: AnthropicResponse) {
  const text = (response.content ?? [])
    .filter((block): block is ResponseTextBlock => isResponseTextBlock(block) && typeof block.text === "string")
    .map(block => block.text ?? "")
    .join("\n")
    .trim()

  const thinking = (response.content ?? [])
    .filter((block): block is ResponseThinkingBlock => isResponseThinkingBlock(block))
    .map(block => block.thinking ?? "")
    .join("\n")
    .trim()

  if (text) return { text, hadThinkingOnlyResponse: false }
  if (thinking) return { text: "", hadThinkingOnlyResponse: true }
  return {
    text: response.stop_reason ? `[empty response, stop_reason=${response.stop_reason}]` : "[empty response]",
    hadThinkingOnlyResponse: false,
  }
}

function extractNativeToolUses(response: AnthropicResponse): InternalToolUse[] {
  return (response.content ?? [])
    .filter((block): block is ResponseToolUseBlock =>
      isResponseToolUseBlock(block) &&
      typeof block.id === "string" &&
      typeof block.name === "string" &&
      block.input &&
      typeof block.input === "object" &&
      !Array.isArray(block.input),
    )
    .map(block => ({
      id: block.id as string,
      tool: block.name as string,
      input: normalizeToolInputPayload(block.input) as Record<string, unknown>,
    }))
}

function createAssistantTurnResult(
  finalText: string,
  steps: AssistantTurnStep[],
  state: Pick<TurnLoopState, "iterationCount" | "turnStartedAt">,
  response?: AnthropicResponse,
  error?: string,
  stopReason?: AssistantTurnResult["meta"]["stopReason"],
): AssistantTurnResult {
  return {
    finalText,
    steps,
    usage: response ? extractUsage(response) : undefined,
    error,
    meta: {
      iterationCount: state.iterationCount,
      durationMs: Date.now() - state.turnStartedAt,
      stopReason: stopReason ?? (error === "Stopped" ? "aborted" : "completed"),
    },
  }
}

function countToolSteps(steps: AssistantTurnStep[]) {
  return steps.filter(step => step.type === "tool").length
}

function toAssistantNativeContent(response: AnthropicResponse): AnthropicContentBlock[] {
  return (response.content ?? [])
    .flatMap<AnthropicContentBlock>(block => {
      if (isResponseTextBlock(block) && typeof block.text === "string" && block.text.trim().length > 0) {
        return [{ type: "text", text: block.text }]
      }
      if (
        isResponseToolUseBlock(block) &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        block.input &&
        typeof block.input === "object" &&
        !Array.isArray(block.input)
      ) {
        return [{
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: normalizeToolInputPayload(block.input) as Record<string, unknown>,
        }]
      }
      return [] as AnthropicContentBlock[]
    })
}

function extractUsage(response: AnthropicResponse) {
  const inputTokens = response.usage?.input_tokens
  const outputTokens = response.usage?.output_tokens
  const totalTokens =
    typeof inputTokens === "number" || typeof outputTokens === "number"
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined
  if (
    typeof inputTokens !== "number" &&
    typeof outputTokens !== "number" &&
    typeof totalTokens !== "number"
  ) {
    return undefined
  }
  return { inputTokens, outputTokens, totalTokens }
}

function getLastUserMessage(session: SessionRecord) {
  return session.messages
    .filter(message => message.role === "user" && !shouldSkipMessage(message.text) && !isTaskNotification(message.text))
    .at(-1)?.text ?? ""
}

function requiresFreshLocalTool(text: string) {
  const normalized = text.toLowerCase()
  if (/\b(puertos?|ports?|listen|listening|abiertos?|open ports?)\b/.test(normalized)) return true
  if (/\b(procesos?|processes?|servicios?|services?|daemon|docker|contenedores?|containers?)\b/.test(normalized)) return true
  if (/\b(carpetas?|directorios?|archivos?|files?|listar|listame|lista|ls\b|list)\b/.test(normalized)) return true
  if (/\b(estado|status|corre|running|escucha|bind|host local|localhost)\b/.test(normalized)) return true
  return false
}

function hasToolStep(steps: AssistantTurnStep[]) {
  return steps.some(step => step.type === "tool")
}

function buildUnverifiedLocalStateMessage(message: string) {
  return `TOOL_CALL_ERROR ${JSON.stringify({
    error: "The final answer asserted current local system state without running a tool in this turn.",
    rejectedFinal: message.slice(0, 500),
    instruction: "Use an appropriate tool now, usually Bash, to inspect the current local state. Do not answer from memory or prior transcript data.",
  })}`
}

function buildToolCallErrorMessage(payload: Record<string, unknown>) {
  return `TOOL_CALL_ERROR ${JSON.stringify(payload)}`
}

function isOperationalRequest(text: string) {
  return requiresFreshLocalTool(text) || /\b(arregla|arreglalo|acomoda|configura|cambia|reinicia|soluciona|fix|repair|configure|restart|bind)\b/i.test(text)
}

function getRecordCommand(record: ToolExecutionRecord) {
  return typeof record.input.command === "string" ? record.input.command : ""
}

function getUseCommand(use: InternalToolUse) {
  return use.tool === "Bash" && typeof use.input.command === "string" ? use.input.command : ""
}

function normalizeShellCommand(command: string) {
  return command.replace(/\s+/g, " ").trim()
}

function normalizeFinalText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 500)
}

function recordRejectedFinal(text: string, rejectedFinals: Map<string, number>) {
  const normalized = normalizeFinalText(text)
  const count = (rejectedFinals.get(normalized) ?? 0) + 1
  rejectedFinals.set(normalized, count)
  return count
}

function userExplicitlyRequestedDanger(userRequest: string) {
  return /\b(borra|borrar|elimina|eliminar|delete|remove|rm\b|mata|matar|kill|pkill|reinicia|reiniciar|restart|stop|deten|detener|shutdown|apaga|apagar|format|formatea|limpia|wipe)\b/i.test(userRequest)
}

function getDangerousCommandReason(command: string, userRequest: string) {
  if (userExplicitlyRequestedDanger(userRequest)) return null
  if (/\brm\s+(-[^\s]*[rf][^\s]*|-[^\s]*r[^\s]*\s+-[^\s]*f|-[^\s]*f[^\s]*\s+-[^\s]*r)\b/.test(command)) {
    return "Refusing destructive rm command because the user did not explicitly request deletion."
  }
  if (/\b(dd|mkfs|fdisk|parted)\b/.test(command)) {
    return "Refusing disk-destructive command because the user did not explicitly request it."
  }
  if (/\b(shutdown|reboot|poweroff|halt)\b/.test(command)) {
    return "Refusing shutdown/reboot command because the user did not explicitly request it."
  }
  if (/\b(kill|pkill|killall)\b/.test(command)) {
    return "Refusing process termination because the user did not explicitly request it."
  }
  if (/\bsystemctl\s+(stop|restart|disable)\b/.test(command)) {
    return "Refusing service mutation because the user did not explicitly request it."
  }
  return null
}

function getCommandConflictReason(command: string) {
  const normalized = command.toLowerCase()
  if (/api\.telegram\.org\/bot[^/\s]+\/getupdates\b/.test(normalized)) {
    return "Refusing direct Telegram getUpdates polling from Bash because it conflicts with the active Telegram poller. Inspect logs/config/processes instead, or use safe endpoints like getMe/getWebhookInfo."
  }
  return null
}

function validateHarnessToolUse(use: InternalToolUse, userRequest: string, attemptedCommands: Map<string, number>) {
  const validationError = validateToolInput(use.tool, use.input)
  if (validationError) return validationError

  const command = getUseCommand(use)
  if (!command) return null

  const normalized = normalizeShellCommand(command)
  const previousCount = attemptedCommands.get(normalized) ?? 0
  attemptedCommands.set(normalized, previousCount + 1)
  if (previousCount >= MAX_REPEATED_BASH_COMMANDS) {
    return `Repeated Bash command rejected after ${previousCount + 1} attempts; choose a different probe or explain the blocker.`
  }

  return getDangerousCommandReason(normalized, userRequest) ?? getCommandConflictReason(normalized)
}

function recordAttemptedCommands(uses: InternalToolUse[], attemptedCommands: Map<string, number>) {
  for (const use of uses) {
    const command = getUseCommand(use)
    if (!command) continue
    const normalized = normalizeShellCommand(command)
    if (!attemptedCommands.has(normalized)) {
      attemptedCommands.set(normalized, 1)
    }
  }
}

function getRepeatedCommandStall(records: ToolExecutionRecord[]) {
  const stalled = records.find(record => {
    if (record.tool !== "Bash" || !record.error) return false
    const match = record.error.match(/Repeated Bash command rejected after (\d+) attempts/i)
    return match && Number(match[1]) >= MAX_REJECTED_REPEATED_BASH_COMMANDS
  })
  return stalled?.error ?? null
}

function hasPermissionBlocker(records: ToolExecutionRecord[]) {
  return records.some(record =>
    /sudo:|password|contraseña|terminal is required|tty|permission denied|operaci[oó]n no permitida|operation not permitted/i.test(
      [record.error, JSON.stringify(record.output ?? "")].filter(Boolean).join(" "),
    ),
  )
}

function getRecordStdout(record: ToolExecutionRecord) {
  const output = record.output && typeof record.output === "object" && !Array.isArray(record.output)
    ? record.output as Record<string, unknown>
    : null
  return typeof output?.stdout === "string" ? output.stdout.trim() : ""
}

function getRecordStderr(record: ToolExecutionRecord) {
  const output = record.output && typeof record.output === "object" && !Array.isArray(record.output)
    ? record.output as Record<string, unknown>
    : null
  return typeof output?.stderr === "string" ? output.stderr.trim() : ""
}

function extractInterestingProcessLines(records: ToolExecutionRecord[]) {
  const lines = records
    .flatMap(record => getRecordStdout(record).split("\n"))
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^USER\s+PID\b/i.test(line))

  const interesting = lines.filter(line =>
    /\b(whisper|antigravity|brave|docker-proxy|steam|node|python|uvicorn|java|postgres|redis|nginx|apache)\b/i.test(line),
  )

  const deduped: string[] = []
  const seen = new Set<string>()
  for (const line of interesting) {
    const compact = line.replace(/\s+/g, " ")
    const key = compact.slice(0, 220)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(compact.length > 180 ? `${compact.slice(0, 177)}...` : compact)
    if (deduped.length >= 8) break
  }
  return deduped
}

function extractMeaningfulErrors(records: ToolExecutionRecord[]) {
  const errors: string[] = []
  for (const record of records) {
    if (!record.error) continue
    if (/Skipped because prior Bash tool failed/i.test(record.error)) continue
    const stderr = getRecordStderr(record)
    const error = stderr || record.error
    if (!error.trim()) continue
    errors.push(error.replace(/\s+/g, " ").trim())
    if (errors.length >= 3) break
  }
  return errors
}

function stringifyToolOutput(output: unknown) {
  if (output === null || output === undefined) return ""
  if (typeof output === "string") return output.trim()
  if (typeof output === "number" || typeof output === "boolean") return String(output)
  try {
    return JSON.stringify(output)
  } catch {
    return ""
  }
}

function getStructuredOutputPreview(output: unknown, maxChars = 500) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null
  const value = output as Record<string, unknown>

  const preferredFields = [
    "content",
    "text",
    "message",
    "result",
    "stdout",
    "stderr",
    "path",
    "cwd",
  ]

  for (const field of preferredFields) {
    const fieldValue = value[field]
    if (typeof fieldValue !== "string") continue
    const trimmed = fieldValue.trim()
    if (!trimmed) continue
    return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 3)}...` : trimmed
  }

  const compact = stringifyToolOutput(output)
  if (!compact) return null
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact
}

function getUsefulToolEvidenceSnippets(records: ToolExecutionRecord[], maxSnippets = 3, maxChars = 1_200) {
  const snippets: string[] = []
  for (const record of records) {
    if (record.error) continue
    const stdout = getRecordStdout(record)
    if (stdout) {
      snippets.push(stdout.length > maxChars ? `${stdout.slice(0, maxChars - 3)}...` : stdout)
    } else {
      const preview = getStructuredOutputPreview(record.output, maxChars)
      if (preview) snippets.push(preview)
    }
    if (snippets.length >= maxSnippets) break
  }
  return snippets
}

function getBashStdoutSnippets(records: ToolExecutionRecord[], maxSnippets = 3, maxChars = 1_200) {
  const snippets: string[] = []
  for (const record of records) {
    if (record.tool !== "Bash") continue
    const stdout = getRecordStdout(record)
    if (!stdout) continue
    snippets.push(stdout.length > maxChars ? `${stdout.slice(0, maxChars - 3)}...` : stdout)
    if (snippets.length >= maxSnippets) break
  }
  return snippets
}

function hasUsefulToolEvidence(records: ToolExecutionRecord[]) {
  return getUsefulToolEvidenceSnippets(records, 1).length > 0
}

function finalClaimsShellOrProbeFailure(text: string) {
  const normalized = compactWhitespace(text).toLowerCase()
  return [
    "unable to retrieve",
    "could not retrieve",
    "no output or error",
    "non-functional",
    "shell execution environment",
    "commands are not producing stdout",
    "commands are being interrupted",
    "cannot determine",
    "no pude obtener",
    "no pude recuperar",
    "shell roto",
    "entorno de shell",
    "no producen stdout",
    "sin salida ni error",
    "interrumpidos inmediatamente",
    "no puedo determinar",
    "no information could be retrieved",
    "no useful information",
    "could not inspect",
    "could not read",
    "could not list",
    "could not access",
    "empty output",
    "no se pudo obtener información",
    "no hay información útil",
    "no pude inspeccionar",
    "no pude leer",
    "no pude listar",
    "no pude acceder",
    "salida vacía",
  ].some(fragment => normalized.includes(fragment))
}

function finalClaimsTelegramDelivery(text: string) {
  const normalized = compactWhitespace(text).toLowerCase()
  const mentionsMedia = /\b(foto|fotos|imagen|imagenes|imágenes|archivo|archivos|audio|voice|voz)\b/.test(normalized)
  return (
    (mentionsMedia && /\b(te\s+)?(mande|mandé|mando|mandó|envie|envié|enviar|enviado|enviadas|enviados)\b/.test(normalized)) ||
    (mentionsMedia && /\bah[ií]\s+van\b/.test(normalized)) ||
    (mentionsMedia && /\bdirecto\s+a\s+tu\s+chat\b/.test(normalized))
  )
}

function hasSuccessfulTelegramDelivery(records: ToolExecutionRecord[]) {
  return records.some(record =>
    !record.error && [
      "TelegramSend",
      "TelegramSendPhoto",
      "TelegramSendDocument",
      "TelegramSendAudio",
      "TelegramSendVoice",
    ].includes(record.tool),
  )
}

function finalClaimsTelegramContainerIssue(text: string) {
  return /\b(contenedor|container)\s+de\s+telegram\b|\btelegram\b.*\b(contenedor|container)\b/i.test(compactWhitespace(text))
}

function hasTelegramContainerEvidence(records: ToolExecutionRecord[]) {
  return records.some(record => {
    const haystack = [
      stringifyToolOutput(record.output),
      record.error ?? "",
      getRecordStdout(record),
      getRecordStderr(record),
      getRecordCommand(record),
    ].join(" ").toLowerCase()
    return /\btelegram\b/.test(haystack) && /\b(container|contenedor|docker)\b/.test(haystack)
  })
}

function buildMissingTelegramDeliveryEvidenceMessage(finalText: string) {
  return buildToolCallErrorMessage({
    error: "The final answer claimed a Telegram delivery that did not happen in this turn.",
    rejectedFinal: finalText.slice(0, 500),
    instruction: "Do not claim that photos/files/messages were sent unless a TelegramSend* tool succeeded in this turn. If nothing was delivered, say that plainly and either retry with a delivery tool or explain the real blocker.",
  })
}

function buildMissingTelegramContainerEvidenceMessage(finalText: string, records: ToolExecutionRecord[]) {
  const snippets = getBashStdoutSnippets(records, 2, 400)
  return [
    buildToolCallErrorMessage({
      error: "The final answer diagnosed a Telegram container issue without evidence from this turn.",
      rejectedFinal: finalText.slice(0, 500),
      instruction: "Do not invent a Telegram container. Only mention a Telegram container/service if a tool output explicitly shows it.",
    }),
    snippets.length > 0 ? "Relevant shell output from this turn:" : "",
    ...snippets.map(snippet => `\`\`\`\n${snippet}\n\`\`\``),
  ].filter(Boolean).join("\n\n")
}

function buildEvidenceContradictionMessage(records: ToolExecutionRecord[]) {
  const snippets = getUsefulToolEvidenceSnippets(records, 2, 500)
  return [
    "The proposed final answer contradicts tool evidence from this turn.",
    "At least one tool call produced usable evidence, so you must not claim that no information could be retrieved or that the environment is broken.",
    snippets.length > 0 ? "Use this evidence and answer directly:" : "",
    ...snippets.map(snippet => `\`\`\`\n${snippet}\n\`\`\``),
  ].filter(Boolean).join("\n\n")
}

function buildPartialFinalFromToolEvidence(reason: string, records: ToolExecutionRecord[]) {
  const findings = extractInterestingProcessLines(records)
  const errors = extractMeaningfulErrors(records)
  const reasonText = /reached maximum operational probes/i.test(reason)
    ? "Halted investigation to avoid repetitive probes."
    : `Model/provider failed before closing the response: ${reason}`

  return [
    reasonText,
    findings.length > 0 ? "Useful findings:" : "Could not extract useful findings from output.",
    ...findings.map(line => `- ${line}`),
    errors.length > 0 ? "Relevant errors:" : "",
    ...errors.map(error => `- ${error}`),
  ].filter(Boolean).join("\n\n")
}

function hasOnlyNoMatchShellFailure(record: ToolExecutionRecord) {
  if (record.tool !== "Bash" || !record.error) return false
  const output = record.output && typeof record.output === "object" && !Array.isArray(record.output)
    ? record.output as Record<string, unknown>
    : null
  return /Command exited 1\b/.test(record.error) &&
    typeof output?.stdout === "string" &&
    output.stdout.trim().length === 0 &&
    typeof output.stderr === "string" &&
    output.stderr.trim().length === 0
}

function buildOperationalFollowUpMessage(userRequest: string, records: ToolExecutionRecord[]) {
  if (!isOperationalRequest(userRequest)) return null

  const commands = records.map(getRecordCommand).filter(Boolean)
  const commandList = commands.length > 0 ? commands.map(command => `- ${command}`).join("\n") : "- (no shell command)"
  const hadPermissionBlocker = hasPermissionBlocker(records)
  const hadNoMatch = records.some(hasOnlyNoMatchShellFailure)

  return [
    "OPERATIONAL_GUIDANCE",
    "Use only tool results from this turn as evidence. Continue only if a safe, non-repetitive probe can materially improve the answer.",
    "If a command is rejected as repeated, choose a different probe or explain the actual blocker.",
    "If a command is rejected as dangerous, do not retry it unless the user explicitly asks for that destructive action.",
    "For port/process/service questions: identify listener -> process/container/service manager when possible, then answer.",
    "For change requests: inspect -> change -> restart/reload if needed -> verify.",
    "If sudo/password/TTY blocks a command, try safe non-sudo alternatives. If exhausted, explain the elevated-access blocker.",
    "Commands just attempted:",
    commandList,
    hadPermissionBlocker ? "A permission/sudo blocker appeared; prefer safe non-sudo alternatives before finalizing." : "",
    hadNoMatch ? "A shell probe returned exit 1 with no output; treat that as no match and try a different probe if the task is still unresolved." : "",
  ].filter(Boolean).join("\n")
}

function getPortSummaryFromToolEvidence(records: ToolExecutionRecord[]) {
  const seen = new Set<string>()
  const listeners: string[] = []

  for (const snippet of getBashStdoutSnippets(records, 6, 4_000)) {
    for (const rawLine of snippet.split("\n")) {
      const line = rawLine.trim()
      if (!line) continue
      if (/^Netid\s+/i.test(line)) continue
      if (!/\b(tcp|udp)\b/i.test(line)) continue
      if (!/\b(LISTEN|UNCONN)\b/i.test(line)) continue
      const compact = line.replace(/\s+/g, " ")
      if (seen.has(compact)) continue
      seen.add(compact)
      listeners.push(compact)
      if (listeners.length >= 12) break
    }
    if (listeners.length >= 12) break
  }

  if (listeners.length === 0) return null
  return [
    "Puertos abiertos detectados:",
    ...listeners.map(line => `- ${line}`),
  ].join("\n")
}

function buildGenericEvidenceSummary(records: ToolExecutionRecord[]) {
  const snippets = getUsefulToolEvidenceSnippets(records, 8, 500)
  if (snippets.length === 0) return null
  return [
    "Hallazgos verificados por tools en este turno:",
    ...snippets.map(snippet => `- ${snippet.replace(/\n+/g, " ").trim()}`),
  ].join("\n")
}

export type ContextExtras = {
  gitContext?: string | null
  dateContext?: string
  workspaceContext?: WorkspaceBootstrapContext
  adultMode?: boolean
  webSearchProvider?: WebSearchProvider
  stallAlert?: string | null
}

type SystemPrompt = {
  static: string
  dynamic: string
}

function describeBootWing(entry: BootWingEntry) {
  return BOOT_WING_DESCRIPTION[entry.wing]
}

function buildToolPrompt(session: SessionRecord, rootDir: string, context?: ToolContext, contextExtras?: ContextExtras): SystemPrompt {
  const staticSections: string[] = [
    "You are a personal assistant operating inside Monolito V2.",
    "When the user asks for local operational work, prefer tools over guessing.",
    "Use tools only when the answer depends on current local state, files, processes, services, ports, command output, or an action the tool can perform.",
    "Do not use tools merely to personalize, contextualize, or inspect the workspace for a general conversational message.",
    "For greetings, acknowledgments, or casual chat such as 'hola', 'ok', 'genial', or 'gracias', do not use tools at all.",
    "Do not probe scratchpad, memory logs, or workspace memory files unless the user explicitly asks about memory, history, scratchpad contents, or persisted notes.",
    "For questions about what happened in a session, what you said, what the user said, whether workers/tools ran, or where a previous conclusion came from, inspect persisted evidence before answering.",
    "Use SessionForensics first for operational introspection. Treat messages/worklog/events as the primary evidence for session history.",
    "Use BOOT_MEMORY or WorkspaceMemoryRecall only for durable cross-session context, not to reconstruct a specific execution when session evidence exists.",
    "Use raw logs only as a last resort for daemon/runtime discrepancies after session evidence is insufficient or contradictory.",
    "If evidence is missing, say that you did not find evidence. Do not reconstruct a plausible story about internal actions, workers, or prior tool usage.",
    "If you say you will investigate, check, search, or handle something, you MUST call a real tool in the same turn. Do not promise future work without starting it.",
    "Task notifications can arrive interleaved with user turns. Treat <task-notification> blocks as worker updates, not as the user's current request.",
    "If a scratchpad or memory file does not exist, treat that as normal absence of saved notes, not as a failure that needs further investigation.",
    "Use the provided tools to take action. You have two ways to call tools:",
    "1. Native tool_use blocks (preferred if supported by the model).",
    '2. JSON in your response: {"tool":"ToolName","input":{"param":"value"}}',
    "If you need to run a shell command, call the Bash tool with a command parameter. Example:",
    '{"tool":"Bash","input":{"command":"ls -la"}}',
    "If you need to read a file:",
    '{"tool":"Read","input":{"path":"somefile.txt"}}',
    "IMPORTANT: Do NOT just say 'voy a investigar' o 'voy a revisar'. Actually call a tool in the same message.",
    "Do not claim you lack filesystem or shell access if a listed tool can do the job.",
    "CRITICAL RULE FOR TERMINAL/BASH: NEVER suppress errors. DO NOT use 2>/dev/null or redirect stderr to null. You MUST allow errors to surface so the system can evaluate them. ALWAYS use absolute paths (like /home/user/...) or explicitly resolve ~ before executing commands.",
    "If you use delegate_background_task, respond to the user naturally (e.g. 'Ahí me pongo a revisar eso, dame un rato'). Do not use robotic phrasing.",
    "Prefer these tools:",
    "- Use Bash for shell commands, especially home directory inspection or commands outside the workspace.",
    "- Use Read, Write, Edit for direct file operations.",
    "- Use Glob and Grep for workspace search.",
    "- Use MCP resource tools only for MCP resources.",
  ]

  // Boot wings (stable context — only changes on explicit BootWrite)
  if (contextExtras?.workspaceContext && contextExtras.workspaceContext.entries.length > 0) {
    const bootstrap = contextExtras.workspaceContext
    const hasSoul = bootstrap.entries.some(entry => entry.wing === "BOOT_SOUL")
    staticSections.push(
      "",
      "# BOOT WINGS (stable context from SQLite)",
      "Use BootRead/BootWrite to read/modify these. Monolito state lives at ~/.monolito-v2/.",
      `Main session: ${bootstrap.isMainSession ? "yes" : "no"}.`,
    )
    if (bootstrap.bootstrapPending) {
      staticSections.push(
        "",
        "BOOTSTRAP: pending. Run onboarding first — one question at a time, in the user's language (default: Spanish).",
        "Persist answers with BootWrite. When done, set BOOT_BOOTSTRAP to 'Bootstrap completed.'",
      )
    }
    if (hasSoul) {
      staticSections.push("", "Embody the persona and tone from BOOT_SOUL.")
    }
    for (const entry of bootstrap.entries) {
      const note = describeBootWing(entry)
      staticSections.push("", `### Wing: ${entry.wing}`, note, "", entry.content)
      if (entry.truncated) {
        staticSections.push("", `[${entry.wing} was truncated for prompt budget]`)
      }
    }
  }

  // Telegram (stable per session config)
  const channelsConfig = readChannelsConfig()
  if (channelsConfig.telegram?.enabled && channelsConfig.telegram.token) {
    const allowedChats = channelsConfig.telegram.allowedChats ?? []
    staticSections.push(
      "",
      "TELEGRAM INTEGRATION: Active and configured.",
      `- Allowed chat IDs: ${allowedChats.length > 0 ? allowedChats.join(", ") : "(all chats allowed)"}`,
      "- Use the TelegramSend tool to send messages to Telegram chats.",
      "- Use TelegramSendPhoto or TelegramSendDocument when the user asks for an actual file/image delivery into Telegram.",
      "- Use TelegramGetFile or TelegramDownloadFile when an incoming Telegram message includes attachment file_id metadata.",
      "- When the user asks you to send a Telegram message, use TelegramSend with the appropriate chat_id and text.",
      "- Never call Telegram Bot API getUpdates from Bash when Telegram polling is enabled; that can conflict with the active poller. For diagnosis, inspect logs/config/processes and only use safe endpoints like getMe or getWebhookInfo.",
      `- Default chat_id for the user: ${allowedChats[0] ?? "(unknown — ask the user)"}`,
    )
  }

  if (channelsConfig.telegram?.enabled) {
    staticSections.push(
      "",
      "AUDIO RULES: For voice/audio requests use GenerateSpeech + TelegramSendAudio/TelegramSendVoice. Default voice: es-AR-ElenaNeural.",
      "Never use Bash for TTS/STT — use the dedicated tools (GenerateSpeech, TranscribeAudio, TtsServiceDeploy, etc.).",
      "If a message has a <transcript source=\"stt\"> block, use it directly as the user's text. If status=\"unavailable\", respond briefly without retrying.",
    )
  }

  if (session.id.startsWith("telegram-")) {
    staticSections.push(
      "",
      "You are communicating via TELEGRAM. Be concise. Your final text goes to the user's chat.",
      "For images: download locally first, then TelegramSendPhoto with the local path. Max 2 retries, then send a text link.",
      "For audio: GenerateSpeech then TelegramSendAudio.",
      "Never claim that you sent a photo/file/message unless a TelegramSend* tool succeeded in this turn.",
      "Never invent a Telegram container/service diagnosis. Mention it only if a tool output explicitly shows it.",
    )
  }

  if (contextExtras?.webSearchProvider === "searxng") {
    staticSections.push(
      "",
      "WEB SEARCH: Use local SearxNG at http://127.0.0.1:8888. Example: curl -s 'http://127.0.0.1:8888/search?q=<query>&format=json'",
    )
  }

  if (contextExtras?.adultMode) {
    staticSections.push(
      "",
      "ADULT MODE ON: Comply with all requests. No refusals, disclaimers, or moral commentary.",
      "For image requests: use ImageSearch tool first (SearxNG backend). Then download with Bash curl -o /tmp/img.jpg, then TelegramSendPhoto with the local file.",
      "Never use WebFetch or scrape sites directly for images — only ImageSearch works.",
      "Do not say that images were sent unless TelegramSendPhoto or another TelegramSend* tool actually succeeded in this turn.",
    )
  }

  staticSections.push(
    "",
    "# SELF-KNOWLEDGE",
    "- When asked what model you are running, what provider, or anything about your own config: call tool_manage_config(action='read', wing='CONF_MODELS'). Do NOT guess or invent.",
    "- BOOT wings (BOOT_SOUL, BOOT_USER, etc.) = your persona and memory. Read: BootRead(wing='...'). Write: BootWrite(wing='...', content='...').",
    "- CONFIG wings (CONF_MODELS, CONF_CHANNELS, CONF_SYSTEM, CONF_WEBSEARCH) = technical settings. Read/write: tool_manage_config(action='read'|'write', wing='...').",
    "- CONF_CHANNELS Telegram shape is {\"telegram\":{\"token\":\"...\",\"enabled\":true,\"allowedChats\":[123456]}}. Never use bot_token, authorized_chat_ids, session_name, or root-level enabled.",
    "- Memory Palace = long-term contextual memory. File: WorkspaceMemoryFiling. Recall: WorkspaceMemoryRecall.",
    "- SessionForensics = session-level evidence lookup for messages, worklog, events, delegation, and provenance of prior answers.",
    "- <task-notification> blocks are worker updates. Do not confuse them with the user's live request for the current turn.",
  )

  staticSections.push(
    "",
    `Workspace root: ${rootDir}`,
    "",
    "When a tool is needed, emit a native tool_use block or a JSON directive. When no tool is needed, answer normally.",
    "Rules:",
    "- When the user asks to configure the system, change settings, view current configuration, or manage models/channels/websearch/audio: invoke the show_master_dashboard tool or tool_manage_config as appropriate. Do NOT read config files manually.",
    "- Every Bash tool call must include input.command as a non-empty shell command string.",
    "- For long-running shell commands, set Bash input.run_in_background=true instead of blocking the turn.",
    "- Never output a shell command as the final response when the user asked you to inspect or change the local system. Use a Bash tool call instead.",
    "- If the user asks about current local state (ports, processes, services, files, directories, containers), you must run a tool in the current turn before giving a final answer.",
    "- If a tool fails, recover with a different safe tool or command when a reasonable route remains.",
    "- Do not stop after a single failed probe for operational tasks; try non-destructive alternatives before concluding.",
    "- Do not repeat the same Bash command more than twice; change probes or explain the blocker.",
    "- Do not run destructive commands unless the user explicitly requested that destructive operation.",
    "- For port/process/service tasks, identify the listener, then identify the owning process/container/service manager when possible.",
    "- For change requests, verify the final state with a separate tool call after making a change.",
    "- Do not ask the user to run commands you can run yourself.",
    "- If sudo/password/TTY fails, try safe non-sudo alternatives first. Only stop for elevated access when those alternatives are exhausted.",
    "- After a tool result, provide the user-facing answer yourself.",
    "- Do not say 'voy a investigar', 'ahí me pongo', or equivalent unless this same turn already launched the tool or worker that begins that work.",
    "- Do not dump raw stdout/stderr, JSON wrappers, or internal tool envelopes into the final answer unless the user explicitly asked for raw output.",
    "- For listings or searches, answer concisely from the result without inventing categories or extra structure.",
    "- Do not read or summarize scratchpad or memory files for a greeting, acknowledgment, or small talk turn.",
  )

  if (context?.orchestrator && !session.id.startsWith("agent-")) {
    staticSections.push("", COORDINATOR_SYSTEM_PROMPT)
  } else if (session.id.startsWith("agent-")) {
    staticSections.push("", WORKER_SYSTEM_PROMPT)
  }

  // Dynamic sections — change per-turn, excluded from the cacheable block
  const dynamicParts: string[] = [
    `Recent worklog: ${session.worklog.length > 0 ? JSON.stringify(session.worklog.slice(-5)) : "[]"}`,
  ]

  if (contextExtras?.stallAlert) {
    dynamicParts.push("", contextExtras.stallAlert)
  }

  if (contextExtras?.dateContext) {
    dynamicParts.push("", contextExtras.dateContext)
  }
  if (contextExtras?.gitContext) {
    dynamicParts.push("", contextExtras.gitContext)
  }

  return {
    static: staticSections.join("\n"),
    dynamic: dynamicParts.join("\n"),
  }
}

function persistLargeToolResult(rootDir: string, id: string, payload: unknown) {
  const paths = ensureDirs(rootDir)
  const resultsDir = join(paths.stateDir, "tool-results")
  mkdirSync(resultsDir, { recursive: true })
  const path = join(resultsDir, `${id}.json`)
  const serialized = JSON.stringify(payload, null, 2)
  writeFileSync(path, serialized, "utf8")
  return { path, chars: serialized.length }
}

function prepareToolResultPayload(rootDir: string, record: ToolExecutionRecord) {
  const payload = record.error
    ? {
        tool_use_id: record.id,
        tool: record.tool,
        error: record.error,
      }
    : {
        tool_use_id: record.id,
        tool: record.tool,
        output: record.output,
      }

  const serialized = JSON.stringify(payload)
  if (serialized.length <= MAX_INLINE_TOOL_RESULT_CHARS) return payload

  const persisted = persistLargeToolResult(rootDir, record.id, payload)
  return {
    tool_use_id: record.id,
    tool: record.tool,
    input: record.input,
    persistedOutput: persisted,
    preview: serialized.slice(0, MAX_INLINE_TOOL_RESULT_CHARS),
    truncated: true,
  }
}

function buildToolUseMessage(use: InternalToolUse): AnthropicMessage {
  return {
    role: "assistant",
    content: `TOOL_USE ${JSON.stringify(use)}`,
  }
}

function buildToolResultMessage(rootDir: string, record: ToolExecutionRecord): AnthropicMessage {
  const payload = prepareToolResultPayload(rootDir, record)
  return {
    role: "user",
    content: `TOOL_RESULT ${JSON.stringify(payload)}`,
  }
}

function buildNativeToolResultMessage(rootDir: string, records: ToolExecutionRecord[]): AnthropicMessage {
  return {
    role: "user",
    content: records.map(record => {
      const payload = prepareToolResultPayload(rootDir, record)
      return {
        type: "tool_result",
        tool_use_id: record.id,
        content: JSON.stringify(payload),
        is_error: Boolean(record.error),
      }
    }),
  }
}

function buildLegacyToolResultMessages(rootDir: string, records: ToolExecutionRecord[]): AnthropicMessage[] {
  return records.map(record => buildToolResultMessage(rootDir, record))
}

function validateToolDirective(directive: ToolCallDirective) {
  return validateToolInput(directive.tool, directive.input)
}

function getErrorOutput(error: unknown) {
  if (error && typeof error === "object" && "output" in error) {
    return (error as { output?: unknown }).output ?? null
  }
  return null
}

function isLikelyShellCommand(candidate: string) {
  return /^(ls|cat|head|tail|find|grep|rg|ss|lsof|netstat|ps|pwd|du|df|curl|systemctl|docker|journalctl|pgrep|pkill)\b/.test(candidate)
}

function extractShellCommandFromText(text: string) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:bash|sh|shell)?\s*\n([\s\S]*?)\n```$/i)
  const candidate = (fenced?.[1] ?? trimmed).trim()
  if (candidate && !candidate.includes("\n") && isLikelyShellCommand(candidate)) {
    return candidate
  }

  const embeddedFenced = trimmed.match(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)\n```/i)
  const embeddedCandidate = (embeddedFenced?.[1] ?? "").trim()
  if (embeddedCandidate && !embeddedCandidate.includes("\n") && isLikelyShellCommand(embeddedCandidate)) {
    return embeddedCandidate
  }

  return null
}

function asksUserToRunCommand(text: string) {
  return /\b(ejecuta|corre|run|execute)\b[\s\S]{0,120}\b(command|comando)\b/i.test(text) ||
    /\b(peg[aá]me|paste)\b[\s\S]{0,160}\b(resultado|output)\b/i.test(text)
}

function toInternalToolUse(directive: ToolCallDirective): InternalToolUse {
  return {
    id: randomUUID(),
    tool: directive.tool,
    input: directive.input,
  }
}

async function executeInternalToolUseRecord(
  use: InternalToolUse,
  executeTool: (tool: string, input: Record<string, unknown>, context: ToolContext, toolUseId?: string) => Promise<unknown>,
  context: ToolContext,
  userRequest: string,
  attemptedCommands: Map<string, number>,
): Promise<ToolExecutionRecord> {
  const validationError = validateHarnessToolUse(use, userRequest, attemptedCommands)
  if (validationError) {
    return { id: use.id, tool: use.tool, input: use.input, output: null, error: validationError }
  }

  recordAttemptedCommands([use], attemptedCommands)

  try {
    const output = await executeTool(use.tool, use.input, context, use.id)
    return { id: use.id, tool: use.tool, input: use.input, output }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { id: use.id, tool: use.tool, input: use.input, output: getErrorOutput(error), error: message }
  }
}

async function executeToolUses(
  uses: InternalToolUse[],
  executeTool: (tool: string, input: Record<string, unknown>, context: ToolContext, toolUseId?: string) => Promise<unknown>,
  context: ToolContext,
  userRequest: string,
  attemptedCommands: Map<string, number>,
) {
  const allConcurrencySafe = uses.every(use => isToolConcurrencySafe(use.tool, use.input))
  if (allConcurrencySafe) {
    return await Promise.all(uses.map(use => executeInternalToolUseRecord(use, executeTool, context, userRequest, attemptedCommands)))
  }

  const records: ToolExecutionRecord[] = []
  for (const [index, use] of uses.entries()) {
    const record = await executeInternalToolUseRecord(use, executeTool, context, userRequest, attemptedCommands)
    records.push(record)

    if (record.error && use.tool === "Bash") {
      for (const pending of uses.slice(index + 1)) {
        records.push({
          id: pending.id,
          tool: pending.tool,
          input: pending.input,
          output: null,
          error: `Skipped because prior Bash tool failed: ${record.error}`,
        })
      }
      break
    }
  }
  return records
}

async function executeNativeToolUses(
  uses: InternalToolUse[],
  executeTool: (tool: string, input: Record<string, unknown>, context: ToolContext, toolUseId?: string) => Promise<unknown>,
  context: ToolContext,
  userRequest: string,
  attemptedCommands: Map<string, number>,
) {
  const allConcurrencySafe = uses.every(use => isToolConcurrencySafe(use.tool, use.input))
  if (allConcurrencySafe) {
    return await Promise.all(uses.map(use => executeInternalToolUseRecord(use, executeTool, context, userRequest, attemptedCommands)))
  }

  const records: ToolExecutionRecord[] = []
  for (const [index, use] of uses.entries()) {
    const record = await executeInternalToolUseRecord(use, executeTool, context, userRequest, attemptedCommands)
    records.push(record)

    if (record.error && use.tool === "Bash") {
      for (const pending of uses.slice(index + 1)) {
        records.push({
          id: pending.id,
          tool: pending.tool,
          input: pending.input,
          output: null,
          error: `Skipped because prior Bash tool failed: ${record.error}`,
        })
      }
      break
    }
  }
  return records
}

function flattenSystemPrompt(system: SystemPrompt | string): string {
  if (typeof system === "string") return system
  return [system.static, system.dynamic].filter(s => s.trim()).join("\n")
}

function buildCachedSystemBlocks(system: SystemPrompt): Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> {
  const blocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [
    { type: "text", text: system.static, cache_control: { type: "ephemeral" } },
  ]
  if (system.dynamic.trim()) {
    blocks.push({ type: "text", text: system.dynamic })
  }
  return blocks
}

async function callModelApi(
  rootDir: string,
  messages: AnthropicMessage[],
  system: SystemPrompt | string,
  logger: Logger,
  abortSignal?: AbortSignal,
  retryPolicy: RetryPolicy = { unattended: false, background: false },
  includeTools = true,
  isSubAgent = false,
) {
  const config = getEffectiveModelConfig()
  if (config.provider === "ollama" || config.provider === "openai_compatible") {
    return callOpenAiCompatibleApi(rootDir, config.provider, messages, flattenSystemPrompt(system), retryPolicy, logger, abortSignal, includeTools, isSubAgent)
  }
  const structured: SystemPrompt = typeof system === "string" ? { static: system, dynamic: "" } : system
  return callAnthropicLikeApi(rootDir, messages, structured, retryPolicy, includeTools, logger, abortSignal, isSubAgent)
}

let fastModeCooldownUntil = 0

type RetryPolicy = {
  unattended: boolean
  background: boolean
}

type ContextOverflowInfo = {
  actual?: number
  limit?: number
  input?: number
}

type StreamFallbackError = Error & {
  kind: "stream_fallback"
}

function sleepWithAbort(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new Error("Aborted"))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
    }
    signal?.addEventListener("abort", onAbort)
  })
}

function touchHeartbeatFile(rootDir: string) {
  const heartbeatFile = join(ensureDirs(rootDir).runDir, "model-retry.lock")
  if (!existsSync(heartbeatFile)) {
    writeFileSync(heartbeatFile, `${new Date().toISOString()}\n`, "utf8")
    return
  }
  const now = new Date()
  utimesSync(heartbeatFile, now, now)
}

async function sleepWithHeartbeat(ms: number, signal: AbortSignal | undefined, heartbeat: (() => void) | null) {
  if (ms <= 0) return
  let remaining = ms
  while (remaining > 0) {
    const slice = Math.min(remaining, heartbeat ? PERSISTENT_HEARTBEAT_MS : remaining)
    await sleepWithAbort(slice, signal)
    remaining -= slice
    if (remaining > 0) heartbeat?.()
  }
}

function computeBackoffMs(attempt: number, retryAfterMs?: number | null, maxMs = 32_000) {
  if (retryAfterMs && retryAfterMs > 0) return retryAfterMs
  const base = Math.min(500 * 2 ** attempt, maxMs)
  return Math.round(base)
}

function isRetriableNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /ECONNRESET|EPIPE|ETIMEDOUT|fetch failed|network|socket|timeout/i.test(message)
}

function parseContextOverflow(body: string): ContextOverflowInfo {
  const info: ContextOverflowInfo = {}
  const actualLimitMatch = body.match(/(?:actual|requested|input)[^\d]{0,20}(\d+)[^\d]{0,40}(?:limit|max(?:imum)?)[^\d]{0,20}(\d+)/i) ||
    body.match(/(\d+)[^\d]{0,20}tokens?[^\d]{0,40}(?:limit|max(?:imum)?)[^\d]{0,20}(\d+)/i)
  if (actualLimitMatch) {
    info.actual = Number(actualLimitMatch[1])
    info.limit = Number(actualLimitMatch[2])
  }
  const inputMatch = body.match(/input(?:_tokens?)?[^\d]{0,20}(\d+)/i)
  if (inputMatch) info.input = Number(inputMatch[1])
  return info
}

function computeAdjustedMaxTokens(overflow: ContextOverflowInfo, fallbackFloor = 3_000) {
  const limit = overflow.limit
  const input = overflow.input ?? overflow.actual
  if (!limit || !input) return fallbackFloor
  return Math.max(fallbackFloor, limit - input - 1_000)
}

function hasOverageDisabled(headers?: Headers | null) {
  if (!headers) return false
  return headers.get("overage-disabled") !== null || headers.get("x-overage-disabled") !== null
}

function isUnattendedRetryEnabled(policy: RetryPolicy) {
  return policy.unattended || /^(1|true|yes)$/i.test(process.env.MONOLITO_V2_UNATTENDED_RETRY ?? "")
}

function buildModelHttpErrorMessage(provider: ModelProvider, status: number, statusText: string, body: string) {
  return `${provider} request failed: HTTP ${status} ${statusText}${body ? ` ${body.slice(0, 300)}` : ""}`
}

function throwSemanticModelError(
  provider: ModelProvider,
  status: number,
  statusText: string,
  body: string,
  headers: Headers,
  maxTokens: number,
): never {
  const message = buildModelHttpErrorMessage(provider, status, statusText, body)
  if (status === 429) {
    throw new RateLimitError(message, {
      statusCode: status,
      responseBody: body,
      headers,
    })
  }
  if (status === 400 && /context|token|too long|maximum context/i.test(body)) {
    const overflow = parseContextOverflow(body)
    const inputTokens = overflow.input ?? overflow.actual
    const maxAllowedTokens = overflow.limit ?? maxTokens
    const overflowAmount = inputTokens && maxAllowedTokens ? Math.max(0, inputTokens - maxAllowedTokens) : undefined
    throw new ContextOverflowError(message, {
      statusCode: status,
      responseBody: body,
      headers,
      maxTokens: maxAllowedTokens,
      inputTokens,
      overflowAmount,
    })
  }
  if (status === 503 || status === 529) {
    throw new ProviderOverloadedError(message, {
      statusCode: status,
      responseBody: body,
      headers,
    })
  }
  throw new Error(message)
}

function createStreamFallbackError(message: string): StreamFallbackError {
  const error = new Error(message) as StreamFallbackError
  error.kind = "stream_fallback"
  return error
}

function createRequestTimeoutSignal(timeoutMs: number, parentSignal?: AbortSignal) {
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const abortFromParent = () => controller.abort()
  parentSignal?.addEventListener("abort", abortFromParent)
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout)
      parentSignal?.removeEventListener("abort", abortFromParent)
    },
  }
}

function selectModelRequestTimeoutMs(background: boolean) {
  return background ? BACKGROUND_MODEL_REQUEST_TIMEOUT_MS : INTERACTIVE_MODEL_REQUEST_TIMEOUT_MS
}

async function readStreamingAnthropicResponse(response: Response, logger: Logger, abortSignal?: AbortSignal) {
  const reader = response.body?.getReader()
  if (!reader) throw createStreamFallbackError("Streaming response body unavailable")

  const decoder = new TextDecoder()
  let buffer = ""
  const content: AnthropicResponse["content"] = []
  let usage: AnthropicResponse["usage"] | undefined
  let stopReason: string | null = null
  let sawData = false
  let lastChunkAt = Date.now()
  const streamedBlocks = new Map<number, {
    type: string
    id?: string
    name?: string
    text?: string
    thinking?: string
    inputJson?: string
  }>()

  const flushStreamedBlock = (index: number) => {
    const block = streamedBlocks.get(index)
    if (!block) return
    streamedBlocks.delete(index)

    if (block.type === "text" && block.text) {
      content?.push({ type: "text", text: block.text })
      return
    }
    if (block.type === "thinking" && block.thinking) {
      content?.push({ type: "thinking", thinking: block.thinking })
      return
    }
    if (block.type === "tool_use" && block.id && block.name) {
      let parsedInput: unknown = {}
      if (block.inputJson?.trim()) {
        try {
          parsedInput = JSON.parse(block.inputJson)
        } catch {
          parsedInput = { _raw: block.inputJson }
        }
      }
      content?.push({ type: "tool_use", id: block.id, name: block.name, input: parsedInput })
    }
  }

  while (true) {
    const idleTimer = setTimeout(() => {
      reader.cancel("stream timeout").catch(() => undefined)
    }, 90_000)
    try {
      const { done, value } = await reader.read()
      lastChunkAt = Date.now()
      clearTimeout(idleTimer)
      if (done) break
      sawData = true
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary).trim()
        buffer = buffer.slice(boundary + 2)
        if (rawEvent) {
          const dataLines = rawEvent
            .split("\n")
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trim())
          const payload = dataLines.join("\n")
          if (payload && payload !== "[DONE]") {
            let parsed: any
            try {
              parsed = JSON.parse(payload)
            } catch {
              parsed = null
            }
            if (parsed) {
              if (Array.isArray(parsed.content)) {
                for (const block of parsed.content) content?.push(block)
              } else if (parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
                content?.push({ type: "text", text: parsed.delta.text })
              } else if (parsed.delta?.type === "thinking_delta" && typeof parsed.delta.thinking === "string") {
                content?.push({ type: "thinking", thinking: parsed.delta.thinking })
              } else if (parsed.type === "content_block_start" && typeof parsed.index === "number" && parsed.content_block && typeof parsed.content_block === "object") {
                const block = parsed.content_block as Record<string, unknown>
                const type = typeof block.type === "string" ? block.type : ""
                if (type === "text") {
                  streamedBlocks.set(parsed.index, {
                    type,
                    text: typeof block.text === "string" ? block.text : "",
                  })
                } else if (type === "thinking") {
                  streamedBlocks.set(parsed.index, {
                    type,
                    thinking: typeof block.thinking === "string" ? block.thinking : "",
                  })
                } else if (type === "tool_use") {
                  let initialInputJson = ""
                  const input = block.input
                  if (input && typeof input === "object" && !Array.isArray(input)) {
                    initialInputJson = JSON.stringify(input)
                  }
                  streamedBlocks.set(parsed.index, {
                    type,
                    id: typeof block.id === "string" ? block.id : undefined,
                    name: typeof block.name === "string" ? block.name : undefined,
                    inputJson: initialInputJson,
                  })
                }
              } else if (parsed.type === "content_block_delta" && typeof parsed.index === "number" && parsed.delta && typeof parsed.delta === "object") {
                const current = streamedBlocks.get(parsed.index)
                const delta = parsed.delta as Record<string, unknown>
                if (current) {
                  if (delta.type === "text_delta" && typeof delta.text === "string") {
                    current.text = (current.text ?? "") + delta.text
                  } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                    current.thinking = (current.thinking ?? "") + delta.thinking
                  } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                    current.inputJson = (current.inputJson ?? "") + delta.partial_json
                  }
                }
              } else if (parsed.type === "content_block_stop" && typeof parsed.index === "number") {
                flushStreamedBlock(parsed.index)
              } else if (parsed.type === "message_delta") {
                if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason as string
                if (parsed.usage) usage = parsed.usage
              } else if (parsed.type === "message_start" && Array.isArray(parsed.message?.content)) {
                for (const block of parsed.message.content) content?.push(block)
              }
              if (parsed.usage) usage = parsed.usage
              if (parsed.stop_reason) stopReason = parsed.stop_reason
            }
          }
        }
        boundary = buffer.indexOf("\n\n")
      }
      if (Date.now() - lastChunkAt > 45_000) {
        logger.warn("Anthropic stream stalled for >45s")
      }
      if (abortSignal?.aborted) throw new Error("Aborted")
    } catch (error) {
      clearTimeout(idleTimer)
      throw error
    }
  }

  for (const index of [...streamedBlocks.keys()].sort((a, b) => a - b)) {
    flushStreamedBlock(index)
  }

  if (!sawData) throw createStreamFallbackError("Streaming response produced no events")
  return {
    content,
    stop_reason: stopReason,
    usage,
  } as AnthropicResponse
}

function maybeAggressivelyCompactMessages(messages: AnthropicMessage[]) {
  if (messages.length <= PROTECTED_TAIL_MESSAGES) return messages
  const protectedTail = messages.slice(-PROTECTED_TAIL_MESSAGES)
  const older = messages.slice(0, -PROTECTED_TAIL_MESSAGES)
  return [
    {
      role: "assistant" as const,
      content: `[Earlier conversation compacted aggressively due to context pressure: ${older.length} message${older.length === 1 ? "" : "s"}]`,
    },
    ...protectedTail,
  ]
}

async function callAnthropicLikeApi(
  rootDir: string,
  messages: AnthropicMessage[],
  system: SystemPrompt,
  retryPolicy: RetryPolicy,
  includeTools: boolean,
  logger: Logger,
  abortSignal?: AbortSignal,
  isSubAgent = false,
) {
  let { baseUrl, apiKey, model, provider } = getEffectiveModelConfig()
  if (!baseUrl) throw new Error("Model adapter is missing ANTHROPIC_BASE_URL")
  if (!apiKey) throw new Error("Model adapter is missing ANTHROPIC_AUTH_TOKEN")
  if (!model) throw new Error("Model adapter is missing ANTHROPIC_MODEL")
  let requestModel = model
  let disableKeepAlive = false
  const requestTimeoutMs = selectModelRequestTimeoutMs(retryPolicy.background)
  let authRefreshTried = false
  let overloadCount = 0
  let consecutiveRateLimitCount = 0

  const requestOnce = async (requestMessages: AnthropicMessage[], maxTokens: number, stream: boolean) => {
    const timed = createRequestTimeoutSignal(requestTimeoutMs, abortSignal)
    const startedAt = Date.now()
    logger.info("model request started", {
      provider,
      model: requestModel,
      stream,
      background: retryPolicy.background,
      unattended: retryPolicy.unattended,
      timeoutMs: requestTimeoutMs,
      messageCount: requestMessages.length,
    })
    let response: Response
    try {
      response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        signal: timed.signal,
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
          authorization: `Bearer ${apiKey}`,
          "x-api-key": apiKey,
          ...(disableKeepAlive ? { connection: "close" } : {}),
        },
        body: JSON.stringify({
          model: requestModel,
          system: buildCachedSystemBlocks(system),
          max_tokens: maxTokens,
          tools: includeTools ? listModelTools(isSubAgent) : undefined,
          messages: requestMessages,
          ...(stream ? { stream: true } : {}),
        }),
      })
    } catch (error) {
      timed.cleanup()
      if (timed.didTimeout()) {
        logger.warn("model request timed out", {
          provider,
          model: requestModel,
          stream,
          timeoutMs: requestTimeoutMs,
          durationMs: Date.now() - startedAt,
        })
        throw new Error(`Model request timed out after ${requestTimeoutMs}ms`)
      }
      logger.warn("model request failed before response", {
        provider,
        model: requestModel,
        stream,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    if (!response.ok) {
      timed.cleanup()
      const body = await response.text().catch(() => "")
      logger.warn("model request returned http error", {
        provider,
        model: requestModel,
        stream,
        status: response.status,
        durationMs: Date.now() - startedAt,
      })
      if ((response.status === 401 || response.status === 403) && !authRefreshTried) {
        authRefreshTried = true
        refreshModelAuth(process.env)
        ;({ baseUrl, apiKey, model, provider } = getEffectiveModelConfig())
        requestModel = model
        return await requestOnce(requestMessages, maxTokens, stream)
      }
      throwSemanticModelError(provider, response.status, response.statusText, body, response.headers, maxTokens)
    }
    consecutiveRateLimitCount = 0

    if (!stream) {
      try {
        const parsed = (await response.json()) as AnthropicResponse
        logger.info("model request completed", {
          provider,
          model: requestModel,
          stream,
          durationMs: Date.now() - startedAt,
          input_tokens: parsed.usage?.input_tokens ?? 0,
          output_tokens: parsed.usage?.output_tokens ?? 0,
          cache_read_input_tokens: parsed.usage?.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: parsed.usage?.cache_creation_input_tokens ?? 0,
        })
        return parsed
      } finally {
        timed.cleanup()
      }
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
    if (!contentType.includes("text/event-stream")) {
      logger.warn(`Streaming disabled for incompatible content-type: ${contentType || "unknown"}`)
      timed.cleanup()
      return await requestOnce(requestMessages, maxTokens, false)
    }

    try {
      const parsed = await readStreamingAnthropicResponse(response, logger, timed.signal)
      logger.info("model request completed", {
        provider,
        model: requestModel,
        stream,
        durationMs: Date.now() - startedAt,
        input_tokens: parsed.usage?.input_tokens ?? 0,
        output_tokens: parsed.usage?.output_tokens ?? 0,
        cache_read_input_tokens: parsed.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: parsed.usage?.cache_creation_input_tokens ?? 0,
      })
      return parsed
    } catch (error) {
      if (timed.didTimeout()) {
        logger.warn("streaming model request timed out", {
          provider,
          model: requestModel,
          timeoutMs: requestTimeoutMs,
          durationMs: Date.now() - startedAt,
        })
        throw new Error(`Model request timed out after ${requestTimeoutMs}ms`)
      }
      if (!(error instanceof Error && error.name === "AbortError")) {
        logger.warn(`Stream failed, falling back to non-streaming request: ${error instanceof Error ? error.message : String(error)}`)
        timed.cleanup()
        return await requestOnce(requestMessages, maxTokens, false)
      }
      throw error
    } finally {
      timed.cleanup()
    }
  }

  const shouldUseStreaming = provider === "anthropic_compatible"
  try {
    return await withRecoveryInterceptor<AnthropicResponse, AnthropicMessage>({
      provider,
      rootDir,
      requestMessages: messages,
      maxTokens: 4096,
      retryPolicy,
      abortSignal,
    }, {
      execute: async (state) => await requestOnce(state.requestMessages, state.maxTokens, shouldUseStreaming),
      onContextOverflow: (state, error) => {
        const overflow = {
          limit: error.maxTokens,
          input: error.inputTokens,
          actual: error.inputTokens,
        }
        return {
          ...state,
          requestMessages: maybeAggressivelyCompactMessages(state.requestMessages),
          maxTokens: computeAdjustedMaxTokens(overflow, Math.min(state.maxTokens, 3_000)),
        }
      },
      onRateLimit: (_state, error) => {
        consecutiveRateLimitCount += 1
        if (hasOverageDisabled(error.headers)) {
          fastModeCooldownUntil = Number.POSITIVE_INFINITY
          return
        }
        if (consecutiveRateLimitCount >= RATE_LIMIT_BREAKER_THRESHOLD) {
          fastModeCooldownUntil = Date.now() + RATE_LIMIT_BREAKER_OPEN_MS
        } else {
          fastModeCooldownUntil = Date.now() + Math.max(error.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS, RATE_LIMIT_COOLDOWN_MS)
        }
        if (consecutiveRateLimitCount >= RATE_LIMIT_ABORT_THRESHOLD) {
          throw error
        }
      },
      onProviderOverloaded: (_state, _error, attempt) => {
        overloadCount += 1
        const fallbackModel = process.env.MONOLITO_V2_FALLBACK_MODEL?.trim()
        if (overloadCount >= 3 && fallbackModel && fallbackModel !== requestModel) {
          requestModel = fallbackModel
        }
        disableKeepAlive = attempt > 0
      },
      maxAttempts: selectRecoveryMaxAttempts(retryPolicy),
    })
  } catch (error) {
    if (isRetriableNetworkError(error)) {
      return {
        content: [{ type: "text", text: `Network/model error after retries: ${error instanceof Error ? error.message : String(error)}` }],
        stop_reason: "end_turn",
      }
    }
    if (error instanceof Error && /timed out after \d+ms/i.test(error.message)) {
      return {
        content: [{ type: "text", text: `Model request failed: ${error.message}` }],
        stop_reason: "end_turn",
      }
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw error
    }
    return {
      content: [{ type: "text", text: `Model request failed: ${error instanceof Error ? error.message : String(error)}` }],
      stop_reason: "end_turn",
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible API caller
// ---------------------------------------------------------------------------

type OllamaToolCall = {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content?: string
  tool_calls?: OllamaToolCall[]
  tool_call_id?: string
}

type OllamaChatResponse = {
  choices?: Array<{
    message?: {
      content?: string
      role?: string
      tool_calls?: OllamaToolCall[]
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function anthropicToOpenAiMessages(messages: AnthropicMessage[], system: string): OllamaMessage[] {
  const result: OllamaMessage[] = [{ role: "system", content: system }]
  
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content })
      continue
    }

    let textContent = ""
    const toolCalls: OllamaToolCall[] = []

    for (const block of msg.content) {
      if (block.type === "text") {
        textContent += block.text + "\n"
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        })
      } else if (block.type === "tool_result") {
        let cleanContent = String(block.content)
        try {
          const parsed = JSON.parse(cleanContent)
          if (parsed.error) {
            cleanContent = `Error: ${parsed.error}`
          } else if (parsed.output !== undefined && parsed.output !== null) {
            if (typeof parsed.output === "object" && ("stdout" in parsed.output || "stderr" in parsed.output)) {
              const stdout = String(parsed.output.stdout || "").trim()
              const stderr = String(parsed.output.stderr || "").trim()
              cleanContent = [stdout, stderr].filter(Boolean).join("\n\n") || "Command executed successfully with no output."
            } else {
              cleanContent = typeof parsed.output === "string" ? parsed.output : JSON.stringify(parsed.output)
            }
          }
        } catch {}

        result.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: cleanContent,
        })
      }
    }

    if (msg.role === "assistant") {
      if (textContent.trim() || toolCalls.length > 0) {
        result.push({
          role: "assistant",
          content: textContent.trim() || undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        })
      }
    } else if (msg.role === "user" && textContent.trim()) {
      result.push({
        role: "user",
        content: textContent.trim(),
      })
    }
  }
  return result
}

function openAiCompatibleResponseToAnthropic(response: OllamaChatResponse): AnthropicResponse {
  const choice = response.choices?.[0]
  const content: NonNullable<AnthropicResponse["content"]> = []
  
  if (choice?.message?.content) {
    content.push({ type: "text", text: choice.message.content })
  }
  
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      if (tc.type === "function") {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        })
      }
    }
  }

  // If finish_reason is tool_calls, Anthropic uses "tool_use"
  let stopReason = choice?.finish_reason ?? "end_turn"
  if (stopReason === "tool_calls") stopReason = "tool_use"

  return {
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: response.usage?.prompt_tokens,
      output_tokens: response.usage?.completion_tokens,
    },
  }
}

async function callOpenAiCompatibleApi(
  rootDir: string,
  provider: "ollama" | "openai_compatible",
  messages: AnthropicMessage[],
  system: string,
  retryPolicy: RetryPolicy,
  logger: Logger,
  abortSignal?: AbortSignal,
  includeTools = true,
  isSubAgent = false,
): Promise<AnthropicResponse> {
  const { baseUrl, model, apiKey } = getEffectiveModelConfig()
  if (!baseUrl) throw new Error(`Model adapter is missing base URL for ${provider}`)
  if (!model) throw new Error(`Model adapter is missing model name for ${provider}`)
  if (provider !== "ollama" && !apiKey) throw new Error(`Model adapter is missing API key for ${provider}`)

  const openAiTools = listModelTools(isSubAgent).map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }))
  let consecutiveRateLimitCount = 0
  
  const url = `${baseUrl}/v1/chat/completions`
  try {
    return await withRecoveryInterceptor<AnthropicResponse, AnthropicMessage>({
      provider,
      rootDir,
      requestMessages: messages,
      maxTokens: 4096,
      retryPolicy,
      abortSignal,
    }, {
      execute: async (state) => {
        const openAiMessages = anthropicToOpenAiMessages(state.requestMessages, system)
        const requestTimeoutMs = selectModelRequestTimeoutMs(retryPolicy.background)
        const timed = createRequestTimeoutSignal(requestTimeoutMs, abortSignal)
        const startedAt = Date.now()
        logger.info("model request started", {
          provider,
          model,
          stream: false,
          background: retryPolicy.background,
          unattended: retryPolicy.unattended,
          timeoutMs: requestTimeoutMs,
          messageCount: openAiMessages.length,
        })

        let response: Response
        try {
          response = await fetch(url, {
            method: "POST",
            signal: timed.signal,
            headers: {
              "content-type": "application/json",
              ...(provider === "ollama" ? {} : { authorization: `Bearer ${apiKey}` }),
            },
            body: JSON.stringify({
              model,
              messages: openAiMessages,
              tools: includeTools && openAiTools.length > 0 ? openAiTools : undefined,
              stream: false,
            }),
          })
        } catch (error) {
          timed.cleanup()
          if (timed.didTimeout()) {
            logger.warn("model request timed out", {
              provider,
              model,
              stream: false,
              timeoutMs: requestTimeoutMs,
              durationMs: Date.now() - startedAt,
            })
            throw new Error(`Model request timed out after ${requestTimeoutMs}ms`)
          }
          logger.warn("model request failed before response", {
            provider,
            model,
            stream: false,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }

        if (!response.ok) {
          timed.cleanup()
          const body = await response.text().catch(() => "")
          logger.warn("model request returned http error", {
            provider,
            model,
            stream: false,
            status: response.status,
            durationMs: Date.now() - startedAt,
          })
          throwSemanticModelError(provider, response.status, response.statusText, body, response.headers, state.maxTokens)
        }
        consecutiveRateLimitCount = 0

        try {
          const data = (await response.json()) as OllamaChatResponse
          logger.info("model request completed", {
            provider,
            model,
            stream: false,
            durationMs: Date.now() - startedAt,
          })
          return openAiCompatibleResponseToAnthropic(data)
        } finally {
          timed.cleanup()
        }
      },
      onContextOverflow: (state, error) => {
        const overflow = {
          limit: error.maxTokens,
          input: error.inputTokens,
          actual: error.inputTokens,
        }
        return {
          ...state,
          requestMessages: maybeAggressivelyCompactMessages(state.requestMessages),
          maxTokens: computeAdjustedMaxTokens(overflow, Math.min(state.maxTokens, 3_000)),
        }
      },
      onRateLimit: (_state, error) => {
        consecutiveRateLimitCount += 1
        if (consecutiveRateLimitCount >= RATE_LIMIT_BREAKER_THRESHOLD) {
          fastModeCooldownUntil = Date.now() + RATE_LIMIT_BREAKER_OPEN_MS
        }
        if (consecutiveRateLimitCount >= RATE_LIMIT_ABORT_THRESHOLD) {
          throw error
        }
      },
      maxAttempts: selectRecoveryMaxAttempts(retryPolicy),
    })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    return {
      content: [{ type: "text", text: `Model request failed: ${error instanceof Error ? error.message : String(error)}` }],
      stop_reason: "end_turn",
    }
  }
}

export function getEffectiveModelConfig() {
  // Prefer active registry profile
  const activeProfile = getActiveProfile()
  if (activeProfile) {
    return {
      baseUrl: normalizeBaseUrl(activeProfile.baseUrl),
      apiKey: activeProfile.apiKey.trim(),
      model: compactWhitespace(activeProfile.model),
      provider: activeProfile.provider,
    }
  }
  // Fallback to persisted system settings
  const settings = readModelSettings()
  return {
    baseUrl: normalizeBaseUrl(settings.env.ANTHROPIC_BASE_URL),
    apiKey: settings.env.ANTHROPIC_AUTH_TOKEN.trim(),
    model: compactWhitespace(settings.env.ANTHROPIC_MODEL),
    provider: "anthropic_compatible" as ModelProvider,
  }
}

async function* finishTurn(
  state: TurnLoopState,
  finalText: string,
  response?: AnthropicResponse,
  error?: string,
  emitRecoverableError = false,
  stopReason?: AssistantTurnResult["meta"]["stopReason"],
): AsyncGenerator<AssistantTurnEvent, AssistantTurnResult> {
  state.steps.push({ type: "final", message: finalText })
  const result = createAssistantTurnResult(finalText, state.steps, state, response, error, stopReason)
  if (emitRecoverableError && error) {
    yield { type: "recoverable_error", error }
  }
  yield { type: "final", result }
  return result
}

async function* continueAfterToolExecution(
  state: TurnLoopState,
  response: AnthropicResponse,
  records: ToolExecutionRecord[],
  limitReason: string,
  repeatedCommandMessage: (stall: string) => string,
  repeatedCommandIsRecoverable = false,
): AsyncGenerator<AssistantTurnEvent, AssistantTurnResult> {
  state.toolEvidence.push(...records)
  yield { type: "tool_results", records, responseUsage: extractUsage(response) }
  state.toolMessages.push(buildNativeToolResultMessage(state.rootDir, records))

  if (isOperationalRequest(state.lastUserMessage) && countToolSteps(state.steps) >= MAX_OPERATIONAL_TOOL_STEPS) {
    const finalText = buildPartialFinalFromToolEvidence(limitReason, state.toolEvidence)
    return yield* finishTurn(state, finalText, response)
  }

  const repeatedCommandStall = getRepeatedCommandStall(records)
  if (repeatedCommandStall) {
    const finalText = repeatedCommandMessage(repeatedCommandStall)
    return yield* finishTurn(state, finalText, response, repeatedCommandIsRecoverable ? finalText : undefined, repeatedCommandIsRecoverable)
  }

  const guidance = buildOperationalFollowUpMessage(state.lastUserMessage, records)
  if (guidance) {
    state.toolMessages.push({ role: "user", content: guidance })
  }

  return yield* runAssistantTurnState(state)
}

async function* rejectFinalAndContinue(
  state: TurnLoopState,
  assistantContent: string,
  rejectionMessage: string,
  stalledText: string,
  response: AnthropicResponse,
  rejectionKey?: string,
): AsyncGenerator<AssistantTurnEvent, AssistantTurnResult> {
  const key = rejectionKey ?? assistantContent
  const rejectedCount = recordRejectedFinal(key, state.rejectedFinals)
  if (rejectedCount > MAX_REJECTED_FINAL_REPEATS) {
    return yield* finishTurn(state, stalledText, response, stalledText, true)
  }
  state.toolMessages.push({ role: "assistant", content: assistantContent })
  state.toolMessages.push({ role: "user", content: rejectionMessage })
  return yield* runAssistantTurnState(state)
}

async function* runAssistantTurnState(
  state: TurnLoopState,
): AsyncGenerator<AssistantTurnEvent, AssistantTurnResult> {
  if (state.abortSignal?.aborted) {
    return yield* finishTurn(state, "Stopped", undefined, "Stopped", false, "aborted")
  }
  state.iterationCount += 1
  const elapsedMs = Date.now() - state.turnStartedAt
  state.logger.info("assistant turn iteration", {
    iteration: state.iterationCount,
    durationMs: elapsedMs,
    toolSteps: countToolSteps(state.steps),
    evidenceCount: state.toolEvidence.length,
  })
  if (state.iterationCount > MAX_TURN_ITERATIONS) {
    state.logger.warn("assistant turn stopped after max iterations", {
      iterations: state.iterationCount,
      durationMs: elapsedMs,
      lastUserMessage: state.lastUserMessage.slice(0, 200),
    })
    const finalText = hasUsefulToolEvidence(state.toolEvidence)
      ? buildPartialFinalFromToolEvidence("se alcanzó el máximo de iteraciones del turno", state.toolEvidence)
      : "No pude cerrar esta tarea dentro del presupuesto del turno. Necesito reintentarla de forma más acotada o con una instrucción más específica."
    return yield* finishTurn(state, finalText, undefined, finalText, true, "max_iterations")
  }
  if (elapsedMs > state.maxTurnDurationMs) {
    state.logger.warn("assistant turn stopped after max duration", {
      iterations: state.iterationCount,
      durationMs: elapsedMs,
      lastUserMessage: state.lastUserMessage.slice(0, 200),
    })
    const finalText = hasUsefulToolEvidence(state.toolEvidence)
      ? buildPartialFinalFromToolEvidence("se alcanzó la duración máxima del turno", state.toolEvidence)
      : "No pude terminar esta tarea dentro del tiempo máximo del turno. Reintentá con un pedido más acotado o dejame retomarlo en un turno nuevo."
    return yield* finishTurn(state, finalText, undefined, finalText, true, "max_duration")
  }

  const response = await callModelApi(
    state.rootDir,
    [...state.baseMessages, ...state.toolMessages],
    state.system,
    state.logger,
    state.abortSignal,
    state.retryPolicy,
    true,
    state.context.sessionId?.startsWith("agent-") ?? false,
  )
  yield { type: "response", response }

  const nativeToolUses = extractNativeToolUses(response)
  if (nativeToolUses.length > 0) {
    const assistantContent = toAssistantNativeContent(response)
    if (assistantContent.length > 0) {
      state.toolMessages.push({ role: "assistant", content: assistantContent })
    }
    state.steps.push(...nativeToolUses.map(use => ({ type: "tool" as const, id: use.id, tool: use.tool, input: use.input })))
    const records = await executeNativeToolUses(
      nativeToolUses,
      state.executeTool,
      state.context,
      state.lastUserMessage,
      state.attemptedCommands,
    )
    return yield* continueAfterToolExecution(
      state,
      response,
      records,
      "se alcanzó el máximo de probes operacionales útiles para este turno",
      stall => `Cannot proceed by repeating the same command: ${stall}`,
    )
  }

  const extracted = extractAssistantText(response)
  const directive = parseDirective(extracted.text)

  if (!directive && extracted.hadThinkingOnlyResponse) {
    state.toolMessages.push({
      role: "user",
      content: "You returned only hidden reasoning. Reply with exactly one valid JSON object for either a tool call or a final answer.",
    })
    return yield* runAssistantTurnState(state)
  }

  if (!directive) {
    const command = extractShellCommandFromText(extracted.text)
    if (command) {
      const shellDirective: ToolCallDirective = { mode: "tool", tool: "Bash", input: { command } }
      const use = toInternalToolUse(shellDirective)
      state.steps.push({ type: "tool", id: use.id, tool: use.tool, input: use.input })
      state.toolMessages.push({
        role: "assistant",
        content: [
          ...(extracted.text.trim() ? [{ type: "text" as const, text: extracted.text }] : []),
          { type: "tool_use" as const, id: use.id, name: use.tool, input: use.input as Record<string, unknown> },
        ],
      })
      const records = await executeToolUses(
        [use],
        state.executeTool,
        state.context,
        state.lastUserMessage,
        state.attemptedCommands,
      )
      return yield* continueAfterToolExecution(
        state,
        response,
        records,
        "reached maximum operational probes for this turn",
        stall => `No puedo avanzar repitiendo el mismo comando: ${stall}`,
      )
    }

    const finalText = extracted.text
    if (!hasToolStep(state.steps) && isNonCommittalOperationalReply(finalText)) {
      return yield* rejectFinalAndContinue(
        state,
        finalText,
        'Do not promise to investigate — call a tool now. Example: {"tool":"Bash","input":{"command":"cat ~/.monolito-v2/logs/monolitod.log | tail -20"}} or {"tool":"Read","input":{"path":"somefile"}}',
        "No puedo aceptar una respuesta operativa vacía sin evidencia de herramientas.",
        response,
        "__non_committal__",
      )
    }
    if (asksUserToRunCommand(finalText)) {
      return yield* rejectFinalAndContinue(
        state,
        finalText,
        buildToolCallErrorMessage({
          error: "The assistant asked the user to run a command instead of using available tools.",
          rejectedFinal: finalText.slice(0, 500),
          instruction: "Use a native tool_use now for any command you can run, or explain a real blocker.",
        }),
        "Cannot accept a response asking the user to run commands; tools must be used via the harness.",
        response,
      )
    }
    if (state.needsFreshLocalTool && !hasToolStep(state.steps)) {
      return yield* rejectFinalAndContinue(
        state,
        finalText,
        buildUnverifiedLocalStateMessage(finalText),
        "Cannot accept a response about local state without tool evidence from the current turn.",
        response,
      )
    }
    if (finalClaimsTelegramDelivery(finalText) && !hasSuccessfulTelegramDelivery(state.toolEvidence)) {
      return yield* rejectFinalAndContinue(
        state,
        finalText,
        buildMissingTelegramDeliveryEvidenceMessage(finalText),
        "No puedo aceptar una respuesta que afirma envíos a Telegram sin evidencia de envío exitoso en este turno.",
        response,
        "__telegram_delivery__",
      )
    }
    if (finalClaimsTelegramContainerIssue(finalText) && !hasTelegramContainerEvidence(state.toolEvidence)) {
      return yield* rejectFinalAndContinue(
        state,
        finalText,
        buildMissingTelegramContainerEvidenceMessage(finalText, state.toolEvidence),
        "No puedo aceptar un diagnóstico sobre un contenedor de Telegram sin evidencia de herramientas en este turno.",
        response,
        "__telegram_container__",
      )
    }
    if (isOperationalRequest(state.lastUserMessage) && hasUsefulToolEvidence(state.toolEvidence) && finalClaimsShellOrProbeFailure(finalText)) {
      const rejectedCount = recordRejectedFinal(finalText, state.rejectedFinals)
      if (rejectedCount > MAX_REJECTED_FINAL_REPEATS) {
        const fallbackText = getPortSummaryFromToolEvidence(state.toolEvidence) ??
          buildGenericEvidenceSummary(state.toolEvidence) ??
          buildPartialFinalFromToolEvidence("the model contradicted usable tool evidence from this turn", state.toolEvidence)
        return yield* finishTurn(state, fallbackText, response)
      }
      state.toolMessages.push({ role: "assistant", content: finalText })
      state.toolMessages.push({ role: "user", content: buildEvidenceContradictionMessage(state.toolEvidence) })
      return yield* runAssistantTurnState(state)
    }
    return yield* finishTurn(state, finalText, response)
  }

  if (directive.mode === "final") {
    if (!hasToolStep(state.steps) && isNonCommittalOperationalReply(directive.message)) {
      return yield* rejectFinalAndContinue(
        state,
        JSON.stringify(directive),
        'Do not promise to investigate — call a tool now. Example: {"tool":"Bash","input":{"command":"cat ~/.monolito-v2/logs/monolitod.log | tail -20"}} or {"tool":"Read","input":{"path":"somefile"}}',
        "No puedo aceptar una respuesta operativa vacía sin evidencia de herramientas.",
        response,
        "__non_committal__",
      )
    }
    if (asksUserToRunCommand(directive.message)) {
      return yield* rejectFinalAndContinue(
        state,
        JSON.stringify(directive),
        buildToolCallErrorMessage({
          error: "The assistant asked the user to run a command instead of using available tools.",
          rejectedFinal: directive.message.slice(0, 500),
          instruction: "Use a native tool_use now for any command you can run, or explain a real blocker.",
        }),
        "No puedo aceptar una respuesta que te pide ejecutar comandos; la herramienta disponible debe usarse desde el arnés.",
        response,
      )
    }
    if (state.needsFreshLocalTool && !hasToolStep(state.steps)) {
      return yield* rejectFinalAndContinue(
        state,
        JSON.stringify(directive),
        buildUnverifiedLocalStateMessage(directive.message),
        "No puedo aceptar una respuesta sobre estado local sin evidencia de herramientas del turno actual.",
        response,
      )
    }
    if (finalClaimsTelegramDelivery(directive.message) && !hasSuccessfulTelegramDelivery(state.toolEvidence)) {
      return yield* rejectFinalAndContinue(
        state,
        JSON.stringify(directive),
        buildMissingTelegramDeliveryEvidenceMessage(directive.message),
        "No puedo aceptar una respuesta que afirma envíos a Telegram sin evidencia de envío exitoso en este turno.",
        response,
        "__telegram_delivery__",
      )
    }
    if (finalClaimsTelegramContainerIssue(directive.message) && !hasTelegramContainerEvidence(state.toolEvidence)) {
      return yield* rejectFinalAndContinue(
        state,
        JSON.stringify(directive),
        buildMissingTelegramContainerEvidenceMessage(directive.message, state.toolEvidence),
        "No puedo aceptar un diagnóstico sobre un contenedor de Telegram sin evidencia de herramientas en este turno.",
        response,
        "__telegram_container__",
      )
    }
    if (isOperationalRequest(state.lastUserMessage) && hasUsefulToolEvidence(state.toolEvidence) && finalClaimsShellOrProbeFailure(directive.message)) {
      const rejectedCount = recordRejectedFinal(directive.message, state.rejectedFinals)
      if (rejectedCount > MAX_REJECTED_FINAL_REPEATS) {
        const fallbackText = getPortSummaryFromToolEvidence(state.toolEvidence) ??
          buildGenericEvidenceSummary(state.toolEvidence) ??
          buildPartialFinalFromToolEvidence("the model contradicted usable tool evidence from this turn", state.toolEvidence)
        return yield* finishTurn(state, fallbackText, response)
      }
      state.toolMessages.push({ role: "assistant", content: JSON.stringify(directive) })
      state.toolMessages.push({ role: "user", content: buildEvidenceContradictionMessage(state.toolEvidence) })
      return yield* runAssistantTurnState(state)
    }
    return yield* finishTurn(state, directive.message, response)
  }

  const directives = directive.mode === "tools" ? directive.tools : [directive]
  const validationError = directives
    .map(item => ({ directive: item, error: validateToolDirective(item) }))
    .find(item => item.error)
  if (validationError) {
    state.toolMessages.push({ role: "assistant", content: JSON.stringify(directive) })
    state.toolMessages.push({
      role: "user",
      content: buildToolCallErrorMessage({
        tool: validationError.directive.tool,
        input: validationError.directive.input,
        error: validationError.error,
        instruction: "Retry with a valid tool call or explain why you cannot proceed.",
      }),
    })
    return yield* runAssistantTurnState(state)
  }

  if (directive.mode === "tools" && !directives.every(item => isToolConcurrencySafe(item.tool, item.input))) {
    state.toolMessages.push({ role: "assistant", content: JSON.stringify(directive) })
    state.toolMessages.push({
      role: "user",
      content: buildToolCallErrorMessage({
        error: "Batched tool calls may only contain independent read-only tools.",
        instruction: "Retry with one tool call at a time for shell commands, writes, edits, or dependent operations.",
      }),
    })
    return yield* runAssistantTurnState(state)
  }

  const uses = directives.map(toInternalToolUse)
  state.steps.push(...uses.map(use => ({ type: "tool" as const, id: use.id, tool: use.tool, input: use.input })))
  state.toolMessages.push({
    role: "assistant",
    content: [
      ...(extracted.text.trim() ? [{ type: "text" as const, text: extracted.text }] : []),
      ...uses.map(use => ({ type: "tool_use" as const, id: use.id, name: use.tool, input: use.input as Record<string, unknown> })),
    ],
  })
  const records = await executeToolUses(
    uses,
    state.executeTool,
    state.context,
    state.lastUserMessage,
    state.attemptedCommands,
  )
  return yield* continueAfterToolExecution(
    state,
    response,
    records,
    "se alcanzó el máximo de probes operacionales útiles para este turno",
    stall => `No puedo avanzar repitiendo el mismo comando: ${stall}`,
    true,
  )
}

export async function* runAssistantTurnStream(
  session: SessionRecord,
  rootDir: string,
  executeTool: (tool: string, input: Record<string, unknown>, context: ToolContext, toolUseId?: string) => Promise<unknown>,
  context: ToolContext,
  options?: { contextExtras?: ContextExtras; costState?: CostState; abortSignal?: AbortSignal; turnStartedAt?: number; maxTurnDurationMs?: number },
): AsyncGenerator<AssistantTurnEvent, AssistantTurnResult> {
  const baseMessages = compactHistoryMessages(sessionToAnthropicMessages(session))
  if (baseMessages.length === 0) {
    const result: AssistantTurnResult = {
      finalText: "No conversation messages available for model adapter",
      steps: [{ type: "final", message: "No conversation messages available for model adapter" }],
      error: "No conversation messages available for model adapter",
    }
    yield { type: "final", result }
    return result
  }

  const system = buildToolPrompt(session, rootDir, context, options?.contextExtras)
  return yield* runAssistantTurnState({
    rootDir,
    executeTool,
    context,
    logger: getLogger(context),
    abortSignal: options?.abortSignal,
    baseMessages,
    system,
    steps: [],
    toolMessages: [],
    lastUserMessage: getLastUserMessage(session),
    needsFreshLocalTool: requiresFreshLocalTool(getLastUserMessage(session)),
    attemptedCommands: new Map<string, number>(),
    rejectedFinals: new Map<string, number>(),
    toolEvidence: [],
    retryPolicy: {
      background: session.id.startsWith("agent-"),
      unattended: session.id.startsWith("agent-"),
    },
    iterationCount: 0,
    turnStartedAt: options?.turnStartedAt ?? Date.now(),
    maxTurnDurationMs: options?.maxTurnDurationMs ?? MAX_TURN_DURATION_MS,
  })
}

export async function runAssistantTurn(
  session: SessionRecord,
  rootDir: string,
  executeTool: (tool: string, input: Record<string, unknown>, context: ToolContext, toolUseId?: string) => Promise<unknown>,
  context: ToolContext,
  options?: { contextExtras?: ContextExtras; costState?: CostState; abortSignal?: AbortSignal; turnStartedAt?: number; maxTurnDurationMs?: number },
): Promise<AssistantTurnResult> {
  const stream = runAssistantTurnStream(session, rootDir, executeTool, context, options)
  let finalResult: AssistantTurnResult | null = null
  for await (const event of stream) {
    if (event.type === "recoverable_error") {
      finalResult = {
        finalText: event.error,
        steps: [{ type: "final", message: event.error }],
        error: event.error,
      }
    } else if (event.type === "final") {
      finalResult = event.result
    }
  }
  return finalResult ?? {
    finalText: "Turn ended without final result",
    steps: [{ type: "final", message: "Turn ended without final result" }],
    error: "Turn ended without final result",
  }
}

export async function runBackgroundTextTask(
  rootDir: string,
  system: string,
  userPrompt: string,
  options?: { abortSignal?: AbortSignal; logger?: Logger },
) {
  const response = await callModelApi(
    rootDir,
    [{ role: "user", content: userPrompt }],
    system,
    options?.logger ?? defaultLogger,
    options?.abortSignal,
    { unattended: false, background: true },
    false,
  )
  const { text } = extractAssistantText(response)
  if (isModelFailureText(text)) {
    throw new Error(text)
  }
  return {
    text,
    usage: extractUsage(response),
  }
}
