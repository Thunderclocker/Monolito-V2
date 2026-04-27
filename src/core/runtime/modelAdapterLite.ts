import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SessionRecord } from "../ipc/protocol.ts"
import { type ToolContext, isToolConcurrencySafe, listModelTools } from "../tools/registry.ts"
import { BOOT_WING_DESCRIPTION, type BootWingEntry } from "../bootstrap/bootWings.ts"
import type { WorkspaceBootstrapContext } from "../context/workspaceContext.ts"
import { estimateTurnCostUSD, type CostState, type TurnUsage } from "../cost/tracker.ts"
import { AbortError, ApiError, ContextOverflowError, HttpError, ProviderOverloadedError, RateLimitError } from "../errors.ts"
import { createLogger, type Logger } from "../logging/logger.ts"
import { loadAndApplyModelSettings, readModelSettings } from "./modelConfig.ts"
import { getActiveProfile, type ModelProvider } from "./modelRegistry.ts"
import { compactSession, getSession, listCanonicalMemoryEntries, updateWorkerJobStatus, upsertWorkerJob } from "../session/store.ts"
import { callProvider, type ConversationMessage, type ProviderConfig, type ProviderResponse, type ToolCall } from "./providers/index.ts"
import { ensureMonolitoRoot } from "../system/root.ts"
import { redactSensitiveText } from "../security/redact.ts"

const defaultLogger = createLogger("modelAdapterLite")
const MAX_TURN_ITERATIONS = 16
const DEFAULT_MAX_TURN_DURATION_MS = 120_000
const MAX_BACKGROUND_TOKENS = 3_000
const MAX_TOOL_RESULT_CHARS = 20_000
const MAX_RATE_LIMIT_RETRIES = 5
const MAX_OVERLOAD_RETRIES = 3

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

type ContextExtras = {
  gitContext?: string | null
  dateContext?: string
  workspaceContext?: WorkspaceBootstrapContext
  adultMode?: boolean
  webSearchProvider?: string
  taskNotifications?: string[]
  stallAlert?: string
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "")
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function shouldSkipMessage(text: string) {
  const normalized = text.trim()
  return normalized.startsWith("/") || normalized.startsWith("<task-notification>")
}

function isConversationRole(role: SessionRecord["messages"][number]["role"]): role is "user" | "assistant" {
  return role === "user" || role === "assistant"
}

function sessionToMessages(session: SessionRecord): ConversationMessage[] {
  return session.messages
    .filter((message): message is SessionRecord["messages"][number] & { role: "user" | "assistant" } =>
      isConversationRole(message.role) && !shouldSkipMessage(message.text),
    )
    .map(message => ({ role: message.role, content: message.text } as ConversationMessage))
}

function getLastUserMessage(session: SessionRecord) {
  return session.messages.filter(message => message.role === "user" && !shouldSkipMessage(message.text)).at(-1)?.text ?? ""
}

function isEvidenceAuditRequest(text: string) {
  const normalized = compactWhitespace(text).toLowerCase()
  return /\b(de donde|de dónde|fuente|fuentes|origen|source|sources|evidencia|evidence|sacaste|salio|salió|herramienta|tool|tools)\b/.test(normalized)
}

function truncate(value: string, max: number) {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}\n...[truncated]`
}

function stringifyToolResult(value: unknown) {
  let serialized = ""
  if (typeof value === "string") serialized = value.trim()
  else {
    try {
      serialized = JSON.stringify(value, null, 2)
    } catch {
      serialized = String(value)
    }
  }
  serialized = redactSensitiveText(serialized)
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return truncate(serialized, MAX_TOOL_RESULT_CHARS)
  }
  const monolitoRoot = ensureMonolitoRoot()
  const outputPath = join(monolitoRoot, "scratchpad", `tool-output-${randomUUID()}.txt`)
  writeFileSync(outputPath, serialized, "utf8")
  try {
    const preview = truncate(serialized, MAX_TOOL_RESULT_CHARS)
    return `${preview}\n...[OUTPUT TRUNCATED]\nFull output saved to: ${outputPath}\nUse the Read tool with offset/line_limit to inspect the rest.`
  } catch {
    return `...[OUTPUT TRUNCATED]\nFull output saved to: ${outputPath}\nUse the Read tool with offset/line_limit to inspect the rest.`
  }
}

function formatToolEvidenceResult(toolCall: ToolCall, status: "success" | "error", value: unknown) {
  const serialized = stringifyToolResult(value)
  return [
    `<tool-evidence tool="${toolCall.name}" status="${status}" tool_use_id="${toolCall.id}">`,
    "This block is runtime evidence from an executed tool. Use it as the source of truth for claims derived from this tool. If the user asks where a prior answer came from, do not deny this tool was used; cite this evidence and its fields/URLs/paths when relevant.",
    "</tool-evidence>",
    serialized,
  ].join("\n")
}

function getMaxBudgetUsd() {
  const raw = readModelSettings().env.MAX_BUDGET_USD
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function enforceBudgetLimit(costState: CostState | undefined, model: string, pendingUsage?: TurnUsage) {
  if (!costState) return
  const maxBudgetUsd = getMaxBudgetUsd()
  if (maxBudgetUsd <= 0) return
  const pendingCostUsd = pendingUsage ? estimateTurnCostUSD(model, pendingUsage) : 0
  const projectedCostUsd = costState.totalCostUSD + pendingCostUsd
  if (projectedCostUsd > maxBudgetUsd) {
    throw new AbortError(`MAX_BUDGET_USD exceeded: projected session cost $${projectedCostUsd.toFixed(6)} is above limit $${maxBudgetUsd.toFixed(6)}.`)
  }
}

async function executeToolCall(
  toolCall: ToolCall,
  executeTool: (tool: string, input: Record<string, unknown>, context: ToolContext, toolUseId?: string) => Promise<unknown>,
  context: ToolContext,
) {
  if (context.sessionId) {
    upsertWorkerJob(context.rootDir, {
      id: toolCall.id,
      sessionId: context.sessionId,
      profileId: context.profileId,
      toolName: toolCall.name,
      toolArgs: JSON.stringify(toolCall.input),
      status: "pending",
    })
  }
  try {
    if (context.sessionId) updateWorkerJobStatus(context.rootDir, toolCall.id, "running")
    const output = await executeTool(toolCall.name, toolCall.input, context, toolCall.id)
    const content = formatToolEvidenceResult(toolCall, "success", output)
    if (context.sessionId) {
      updateWorkerJobStatus(context.rootDir, toolCall.id, "completed", { resultText: content })
    }
    return {
      toolCall,
      content,
    }
  } catch (error) {
    const content = formatToolEvidenceResult(toolCall, "error", { error: error instanceof Error ? error.message : String(error) })
    if (context.sessionId) {
      updateWorkerJobStatus(context.rootDir, toolCall.id, "failed", { errorText: content })
    }
    return {
      toolCall,
      content,
    }
  }
}

function sumUsage(total: TurnUsage | undefined, next: TurnUsage | undefined): TurnUsage | undefined {
  if (!total && !next) return undefined
  return {
    inputTokens: (total?.inputTokens ?? 0) + (next?.inputTokens ?? 0),
    outputTokens: (total?.outputTokens ?? 0) + (next?.outputTokens ?? 0),
    cacheReadInputTokens: (total?.cacheReadInputTokens ?? 0) + (next?.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (total?.cacheCreationInputTokens ?? 0) + (next?.cacheCreationInputTokens ?? 0),
  }
}

function finalize(finalText: string, steps: AssistantTurnStep[], startedAt: number, iterationCount: number, usage?: TurnUsage, error?: string, stopReason: AssistantTurnResult["meta"]["stopReason"] = "completed"): AssistantTurnResult {
  const safeFinalText = redactSensitiveText(finalText)
  return {
    finalText: safeFinalText,
    steps: [...steps, { type: "final", message: safeFinalText }],
    error: error ? redactSensitiveText(error) : undefined,
    usage: usage ? {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    } : undefined,
    meta: {
      iterationCount,
      durationMs: Date.now() - startedAt,
      stopReason,
    },
  }
}

function getLogger(context?: ToolContext, logger?: Logger) {
  return logger ?? context?.logger ?? defaultLogger
}

function buildToolSummary(isSubAgent: boolean, lastUserMessage?: string) {
  return listModelTools(isSubAgent, lastUserMessage)
    .map(tool => `- ${tool.name}: ${tool.description}`)
    .join("\n")
}

function describeBootEntries(entries: BootWingEntry[]) {
  if (entries.length === 0) return ""
  return entries
    .map(entry => `## ${entry.wing}\n${BOOT_WING_DESCRIPTION[entry.wing]}\n${truncate(entry.content, 2_500)}`)
    .join("\n\n")
}

function buildSystemPrompt(args: {
  session: SessionRecord
  rootDir: string
  context?: ToolContext
  bootstrap?: WorkspaceBootstrapContext
  extras?: ContextExtras
  systemPromptOverride?: string
}) {
  if (args.systemPromptOverride?.trim()) return { system: args.systemPromptOverride.trim(), bootBlock: "" }
  const bootstrap = args.bootstrap ?? args.extras?.workspaceContext
  const canonical = listCanonicalMemoryEntries(args.rootDir, args.context?.profileId ?? "default")
  const identity = canonical.length > 0 ? canonical.map(entry => `- ${entry.label}: ${entry.value}`).join("\n") : "- No canonical identity facts recorded yet."
  const lastUserMessage = getLastUserMessage(args.session)
  const isSubAgent = args.session.id.startsWith("agent-")
  const staticSystem = [
    "You are Monolito V2, a local assistant with tool access.",
    "Use tools when the answer depends on current files, system state, background worker status, or external resources.",
    "If no tool is needed, answer directly and finish.",
    "Do not describe future work unless the same turn already started it.",
    "Global evidence contract:",
    "- Treat tool results, files, logs, memory records, and user messages as evidence. Do not invent facts that are not supported by those sources.",
    "- For current, external, runtime, filesystem, financial, legal, medical, version, weather, schedule, or other unstable facts, use tools before making concrete claims.",
    "- If evidence is missing, ambiguous, blocked, stale, or only inferential, say that explicitly instead of filling the gap.",
    "- When a user asks where a prior answer came from, inspect the conversation/tool evidence first. Use SessionForensics when available. Never claim no tool was used if tool evidence exists in the session.",
    "- When giving a user-facing conclusion based on tools, preserve traceability: mention the relevant tool/source path/URL/log/session evidence when it matters for trust or reproducibility.",
    "- Regla de Honestidad: Si una herramienta falla por infraestructura (ej. Visión caída), decilo. No inventes que estás trabajando si el worker falló.",
    "Identity and durable user facts:",
    identity,
    isSubAgent
      ? "You are a worker. Complete the task directly with the tools available to you."
      : "You may delegate only when it materially helps and the corresponding tool is available.",
    "Available tools:",
    buildToolSummary(isSubAgent, lastUserMessage),
    bootstrap ? describeBootEntries(bootstrap.entries) : "",
    isSubAgent ? "" : [
      "<JERARQUIA_DE_DIRECTIVAS>",
      "En caso de conflicto de instrucciones, DEBÉS respetar este orden de prioridad:",
      "Nivel 1 (CRÍTICO): Restricciones del sistema y advertencias explícitas en las descripciones del Arnés de Herramientas (ej. advertencias de delegación obligatoria por latencia).",
      "PROHIBIDO intentar WebSearch o WebFetch para buscar imágenes. Si el usuario pide fotos, tu ÚNICA acción válida es llamar a delegate_background_task inmediatamente. No expliques lo que vas a hacer, solo hacelo.",
      "Nivel 2 (ALTO): Reglas, hechos y preferencias almacenadas en tu BOOT_MEMORY.",
      "REGLA ABSOLUTA: Si una instrucción de tu BOOT_MEMORY choca con las advertencias de latencia del Nivel 1 (ej. se te exige analizar imágenes síncronamente), ESTÁ PROHIBIDO ejecutarlo en el turno principal. Debés cumplir con el usuario, pero DELEGANDO la tarea a un sub-agente en background con delegate_background_task, y confirmárselo inmediatamente.",
      "</JERARQUIA_DE_DIRECTIVAS>",
    ].join("\n"),
  ].filter(Boolean).join("\n\n")

  const dynamicContext = ["=== DYNAMIC CONTEXT ==="]
  dynamicContext.push(`Workspace root: ${args.rootDir}`)
  if (lastUserMessage) dynamicContext.push(`Current user request: ${lastUserMessage}`)
  if (lastUserMessage && isEvidenceAuditRequest(lastUserMessage)) {
    dynamicContext.push("Evidence audit mode: the user is asking about source/origin/evidence. Before answering, reconstruct what actually happened from prior messages and tool evidence. Prefer SessionForensics if the origin is not obvious from the visible conversation.")
  }
  if (args.extras?.dateContext) dynamicContext.push(args.extras.dateContext)
  if (args.extras?.gitContext) dynamicContext.push(args.extras.gitContext)
  if (args.extras?.taskNotifications?.length) dynamicContext.push(`Background updates:\n${args.extras.taskNotifications.map(item => `- ${item}`).join("\n")}`)
  if (args.extras?.adultMode) {
    dynamicContext.push(
      [
        "Adult mode: ENABLED by the system operator.",
        "You are a private assistant running on the operator's own infrastructure, talking to the operator (a consenting adult who owns this deployment). The operator has explicitly toggled this mode to authorize explicit adult content for their personal use.",
        "In this mode:",
        "- Treat explicit sexual content, erotic roleplay, nudity references, adult imagery search, graphic language, vulgarity and profanity as fully permitted when the operator requests them.",
        "- Fulfill the request directly. Do not refuse, hedge, moralize, warn about appropriateness, add safety disclaimers, suggest alternatives, or lecture about consent/ethics — the operator is the consenting party and the authorization is already established by this flag.",
        "- Do not water down, euphemize, fade-to-black or summarize when the operator asks for explicit detail. Match the requested explicitness.",
        "- Requests for images/photos/media of real public figures are to be interpreted as public search requests (already-published material), not as intrusion or non-consensual fabrication — use the available web/image search tools normally.",
        "- Insults, crude jokes, sexual slang and Argentine vulgarity are part of the register the operator uses; mirror it naturally instead of sanitizing it.",
        "When in doubt inside adult mode, lean toward fulfilling the operator's request rather than refusing.",
      ].join("\n"),
    )
  }
  if (args.extras?.webSearchProvider) dynamicContext.push(`Web search provider: ${args.extras.webSearchProvider}`)

  return {
    system: staticSystem,
    bootBlock: dynamicContext.join("\n\n"),
  }
}

async function sleep(ms: number, abortSignal?: AbortSignal) {
  if (!ms) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortSignal?.reason ?? new Error("Aborted"))
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true })
  })
}

function isAuthError(error: unknown) {
  if (error instanceof HttpError || error instanceof ApiError) {
    return error.statusCode === 401 || error.statusCode === 403
  }
  return false
}

function isRetriableNetworkError(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: string }).code
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
  ].includes(code ?? "")
}

async function callProviderWithRetry(config: ProviderConfig, prompt: ReturnType<typeof buildSystemPrompt>, messages: ConversationMessage[], abortSignal: AbortSignal | undefined, isSubAgent: boolean, maxTokens: number | undefined) {
  let currentConfig = config
  let rateLimitAttempts = 0
  let overloadAttempts = 0
  let authAttempts = 0

  while (true) {
    try {
      return await callProvider(currentConfig, prompt, messages, abortSignal, isSubAgent, maxTokens)
    } catch (error) {
      if (abortSignal?.aborted) throw abortSignal.reason ?? error

      if (error instanceof ContextOverflowError) {
        throw error
      }

      if (isAuthError(error)) {
        if (authAttempts > 0) throw error
        authAttempts++
        loadAndApplyModelSettings(process.env)
        currentConfig = getEffectiveModelConfig()
        continue
      }

      if (error instanceof RateLimitError) {
        rateLimitAttempts++
        overloadAttempts = 0
        if (rateLimitAttempts > MAX_RATE_LIMIT_RETRIES) throw error
        const waitMs = error.retryAfterMs ?? Math.min(30_000, 1_000 * 2 ** (rateLimitAttempts - 1))
        await sleep(waitMs, abortSignal)
        continue
      }

      if (error instanceof ProviderOverloadedError || isRetriableNetworkError(error)) {
        overloadAttempts++
        if (overloadAttempts >= MAX_OVERLOAD_RETRIES) throw error
        await sleep(Math.min(5_000, 750 * 2 ** (overloadAttempts - 1)), abortSignal)
        continue
      }

      throw error
    }
  }
}

export function getEffectiveModelConfig() {
  const activeProfile = getActiveProfile()
  if (activeProfile) {
    return {
      baseUrl: normalizeBaseUrl(activeProfile.baseUrl),
      apiKey: activeProfile.apiKey.trim(),
      model: compactWhitespace(activeProfile.model),
      provider: activeProfile.provider,
    }
  }
  const settings = readModelSettings()
  return {
    baseUrl: normalizeBaseUrl(settings.env.ANTHROPIC_BASE_URL),
    apiKey: settings.env.ANTHROPIC_AUTH_TOKEN.trim(),
    model: compactWhitespace(settings.env.ANTHROPIC_MODEL),
    provider: "anthropic_compatible" as ModelProvider,
  }
}

export async function runAssistantTurn(
  session: SessionRecord,
  rootDir: string,
  executeTool: (tool: string, input: Record<string, unknown>, context: ToolContext, toolUseId?: string) => Promise<unknown>,
  context: ToolContext,
  options?: {
    logger?: Logger
    abortSignal?: AbortSignal
    bootstrap?: WorkspaceBootstrapContext
    systemPromptOverride?: string
    maxIterations?: number
    maxTurnDurationMs?: number
    maxTokens?: number
    costState?: CostState
    contextExtras?: ContextExtras
    turnStartedAt?: number
  },
): Promise<AssistantTurnResult> {
  const logger = getLogger(context, options?.logger)
  const startedAt = options?.turnStartedAt ?? Date.now()
  const maxIterations = options?.maxIterations ?? MAX_TURN_ITERATIONS
  const maxTurnDurationMs = options?.maxTurnDurationMs ?? DEFAULT_MAX_TURN_DURATION_MS
  const config = getEffectiveModelConfig()
  const isSubAgent = session.id.startsWith("agent-")
  let activeSession = session
  let compacted = false
  let usage: TurnUsage | undefined
  const steps: AssistantTurnStep[] = []
  const messages = sessionToMessages(session)
  const prompt = buildSystemPrompt({ session: activeSession, rootDir, context, bootstrap: options?.bootstrap, extras: options?.contextExtras, systemPromptOverride: options?.systemPromptOverride })

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    enforceBudgetLimit(options?.costState, config.model)
    if (options?.abortSignal?.aborted) return finalize("", steps, startedAt, iteration - 1, usage, undefined, "aborted")
    if (Date.now() - startedAt > maxTurnDurationMs) return finalize("", steps, startedAt, iteration - 1, usage, "Turn duration exceeded", "max_duration")
    try {
      const response = await callProviderWithRetry(config, prompt, messages, options?.abortSignal, isSubAgent, options?.maxTokens)
      enforceBudgetLimit(options?.costState, config.model, response.usage)
      usage = sumUsage(usage, response.usage)
      if (response.toolCalls.length === 0) return finalize(response.text, steps, startedAt, iteration, usage)
      const assistantMessage: ConversationMessage = { role: "assistant", content: response.text, toolCalls: response.toolCalls }
      messages.push(assistantMessage)
      for (const toolCall of response.toolCalls) {
        steps.push({ type: "tool", id: toolCall.id, tool: toolCall.name, input: toolCall.input })
      }

      const indexedToolCalls = response.toolCalls.map((toolCall, index) => ({ toolCall, index }))
      const safeToolCalls = indexedToolCalls.filter(({ toolCall }) => isToolConcurrencySafe(toolCall.name, toolCall.input))
      const unsafeToolCalls = indexedToolCalls.filter(({ toolCall }) => !isToolConcurrencySafe(toolCall.name, toolCall.input))
      const toolResults = new Array<{ role: "tool"; toolCallId: string; toolName: string; content: string }>(response.toolCalls.length)

      const safeResults = await Promise.all(
        safeToolCalls.map(async ({ toolCall, index }) => {
          const result = await executeToolCall(toolCall, executeTool, context)
          return {
            index,
            message: {
              role: "tool" as const,
              toolCallId: result.toolCall.id,
              toolName: result.toolCall.name,
              content: result.content,
            },
          }
        }),
      )
      for (const result of safeResults) {
        toolResults[result.index] = result.message
      }

      for (const { toolCall, index } of unsafeToolCalls) {
        const result = await executeToolCall(toolCall, executeTool, context)
        toolResults[index] = {
          role: "tool",
          toolCallId: result.toolCall.id,
          toolName: result.toolCall.name,
          content: result.content,
        }
      }

      for (const toolResult of toolResults) {
        if (!toolResult) continue
        messages.push(toolResult)
      }
    } catch (error) {
      if (options?.abortSignal?.aborted) return finalize("", steps, startedAt, Math.max(0, steps.length), usage, undefined, "aborted")
      if (error instanceof ContextOverflowError && !compacted) {
        compactSession(rootDir, session.id)
        const refreshed = getSession(rootDir, session.id)
        if (refreshed) {
          activeSession = refreshed
          messages.splice(0, messages.length, ...sessionToMessages(refreshed))
        }
        compacted = true
        continue
      }
      if (error instanceof AbortError) throw error
      logger.error("assistant turn failed", { error: error instanceof Error ? error.message : String(error), sessionId: session.id })
      const message = error instanceof Error ? error.message : String(error)
      return finalize(message, steps, startedAt, Math.min(maxIterations, steps.length + 1), usage, message)
    }
  }
  return finalize("", steps, startedAt, maxIterations, usage, "Max iterations reached", "max_iterations")
}

export async function runBackgroundTextTask(
  _rootDir: string,
  system: string,
  userPrompt: string,
  options?: { model?: string; maxTokens?: number; abortSignal?: AbortSignal; logger?: Logger },
): Promise<{ text: string; usage?: TurnUsage }> {
  const config = getEffectiveModelConfig()
  const prompt = { system, bootBlock: "" }
  const messages: ConversationMessage[] = [{ role: "user", content: userPrompt }]
  const response = await callProviderWithRetry(
    { ...config, model: options?.model?.trim() || config.model },
    prompt,
    messages,
    options?.abortSignal,
    false,
    options?.maxTokens ?? MAX_BACKGROUND_TOKENS,
  )
  return { text: response.text, usage: response.usage }
}
