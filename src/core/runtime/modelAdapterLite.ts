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
const MAX_TOOL_RESULT_CHARS = 10_000
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

export type AgentLoopRecoverableAction = "backoff" | "compact_context" | "reload_auth"

export type AgentLoopEvent =
  | { type: "setup"; sessionId: string; iteration: number; model: string; maxIterations: number; maxTurnDurationMs: number }
  | { type: "model_invoke_start"; sessionId: string; iteration: number; model: string }
  | { type: "model_stream"; sessionId: string; iteration: number; text: string }
  | { type: "model_invoke_end"; sessionId: string; iteration: number; usage?: AssistantTurnResult["usage"]; toolCallCount: number }
  | { type: "tool_execute_start"; sessionId: string; iteration: number; toolUseId?: string; tool: string; input: Record<string, unknown> }
  | { type: "tool_execute_end"; sessionId: string; iteration: number; toolUseId?: string; tool: string; ok: boolean }
  | { type: "recoverable_error"; sessionId: string; iteration: number; action: AgentLoopRecoverableAction; error: string; retryAfterMs?: number }
  | { type: "done"; sessionId: string; result: AssistantTurnResult }

type ContextExtras = {
  gitContext?: string | null
  dateContext?: string
  workspaceContext?: WorkspaceBootstrapContext
  webSearchProvider?: string
  taskNotifications?: string[]
  stallAlert?: string
  activeTasks?: { agentId: string; description: string; status: string; progress?: string[] }[]
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
  const preview = truncate(serialized, MAX_TOOL_RESULT_CHARS)
  return `${preview}\n\n[... TRUNCADO: La salida superó el límite de seguridad de memoria. Usa comandos más específicos (ej. grep, head) o afina tu búsqueda.]\nFull output saved to: ${outputPath}\nUse the Read tool with offset/line_limit to inspect the rest.`
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
  const isImageIntent = lastUserMessage && /imagen|imagenes|foto|fotos|picture|pictures|image|images|vision|visual/i.test(lastUserMessage)
  const staticSystem = [
    "You are Monolito V2, a local assistant with tool access.",
    "Use tools when the answer depends on current files, system state, internal task status, or external resources.",
    "If no tool is needed, answer directly and finish.",
    "Do not describe future work unless the same turn already started it.",
    "Global evidence contract:",
    "- Treat tool results, files, logs, memory records, and user messages as evidence. Do not invent facts that are not supported by those sources.",
    "- For current, external, runtime, filesystem, financial, legal, medical, version, weather, schedule, or other unstable facts, use tools before making concrete claims.",
    "- If evidence is missing, ambiguous, blocked, stale, or only inferential, say that explicitly instead of filling the gap.",
    "- If a user asks you to generate or send audio/voice, you must call GenerateSpeech and then the relevant delivery tool (TelegramSendAudio/TelegramSendVoice for Telegram) before saying the audio is generated, sent, or being delivered. If a required tool fails, report the failure plainly instead of promising more work.",
    "- When a user asks where a prior answer came from, inspect the conversation/tool evidence first. Use SessionForensics when available. Never claim no tool was used if tool evidence exists in the session.",
    "- When giving a user-facing conclusion based on tools, preserve traceability: mention the relevant tool/source path/URL/log/session evidence when it matters for trust or reproducibility.",
    "- Regla de Honestidad: Si una herramienta falla por infraestructura (ej. Visión caída), decilo. No inventes que estás trabajando si una tarea interna falló.",
    "Identity and durable user facts:",
    identity,
    isSubAgent
      ? [
          "You are a worker. Complete the task directly with the tools available to you.",
          "REGLAS CRÍTICAS PARA WORKERS:",
          "- Sos un ejecutor interno. Nunca te comuniques con el usuario final ni envíes contenido a canales externos. Devolvé evidencia/resultados al coordinador.",
          "- Ejecutá la tarea recibida de forma directa. No leas el código del runtime, documentación interna ni archivos del repo para reinterpretar las reglas salvo que la tarea explícitamente pida modificar o investigar el código.",
          "- PROHIBIDO delegar a otros workers o intentar usar delegate_background_task. Si necesitás más pasos, hacelos vos con tus herramientas disponibles.",
          "- PROHIBIDO usar Bash para invocar APIs externas de LLM, visión o procesamiento de imágenes (ej. openai.vision, anthropic.messages, client.beta.vision, llamadas HTTP a providers de IA). El Bash es solo para operaciones de sistema (archivos, proceso, red básica).",
          isImageIntent
            ? "- Para analizar imágenes, usa PRIMERO WebSearch/WebFetch para obtenerla y LUEGO invoca la herramienta VisionAnalyze. NUNCA uses Bash."
            : "- Para busquedas simples de imagenes, usa ImageSearch y devolve image_url directas. No uses WebFetch ni scraping de paginas fuente.",
          "- Para analizar o describir el contenido visual de una imagen cuando se solicite explicitamente, DEBÉS usar la herramienta AnalyzeImage con la URL. Nunca escribas un script Python que llame a una API de visión externa.",
          "- Si la tarea requiere fotos para Telegram sin pedir verificacion visual, devolvé image_url directas; el coordinador se encarga de enviarlas.",
          "- Si la tarea requiere verificacion visual de fotos para Telegram, cada imagen válida debe pasar por AnalyzeImage. Devolvé los local_path validados; el coordinador se encarga de enviarlas.",
          "- Si AnalyzeImage falla (servicio caído, timeout), reportá el error explícitamente. No intentes workarounds via Bash.",
        ].join("\n")
      : [
          "You may delegate only when it materially helps and the corresponding tool is available.",
          "Delegation is an internal implementation detail. Unless the user explicitly asks how work is being coordinated, do not mention workers, agents, background tasks, delegation, or internal orchestration. Present completed work as your own actions.",
          "ANTI-ALUCINACION DE FOTOS: Si el usuario pide enviar imágenes y tenés image_url o local_path disponibles, DEBÉS ejecutar TelegramSendPhoto ANTES de emitir cualquier respuesta de texto. NUNCA respondas con una lista o descripción textual de las fotos asumiendo que eso equivale a enviarlas.",
          "For Telegram audio/voice requests, do not send a progress-only reply like 'generating audio' unless the same turn already started GenerateSpeech. Complete the sequence GenerateSpeech -> TelegramSendAudio/TelegramSendVoice, then confirm only after the send tool succeeds.",
        ].join("\n"),
    "Available tools:",
    buildToolSummary(isSubAgent, lastUserMessage),
    bootstrap ? describeBootEntries(bootstrap.entries) : "",
    isSubAgent ? "" : [
      "<JERARQUIA_DE_DIRECTIVAS>",
      "En caso de conflicto de instrucciones, DEBÉS respetar este orden de prioridad:",
      "Nivel 1 (CRÍTICO): Restricciones del sistema y advertencias explícitas en las descripciones del Arnés de Herramientas (ej. advertencias de delegación obligatoria por latencia).",
      "PROHIBIDO intentar WebSearch o WebFetch para buscar imágenes. Para busquedas simples de fotos/imagenes, usa ImageSearch directamente y entrega los image_url o mandalos con TelegramSendPhoto si corresponde.",
      "Si el usuario pide verificar, validar, analizar o describir visualmente imagenes, delega esa verificacion con delegate_background_task. No uses AnalyzeImage en el turno principal.",
      "Nivel 2 (ALTO): Reglas, hechos y preferencias almacenadas en tu BOOT_MEMORY.",
      "REGLA ABSOLUTA: Si una instrucción de tu BOOT_MEMORY exige analizar imágenes síncronamente, ESTÁ PROHIBIDO ejecutarlo en el turno principal. Debés cumplir con el usuario usando delegate_background_task internamente y confirmarlo como acción propia, sin mencionar delegación, workers ni sub-agentes salvo que el usuario pregunte por la mecánica.",
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
  if (args.extras?.activeTasks?.length) {
    dynamicContext.push(`Internal work in progress:\n${args.extras.activeTasks.map(t => `- [${t.status}] ${t.description}${t.progress?.length ? ` (${t.progress.join("; ")})` : ""}`).join("\n")}\n\nNote: This is internal state. Do not mention workers or agents to the user unless explicitly asked.`)
  }
  if (args.extras?.taskNotifications?.length) dynamicContext.push(`Internal task updates:\n${args.extras.taskNotifications.map(item => `- ${item}`).join("\n")}\n\nDo not expose the internal task mechanism. If files must be delivered to Telegram, use the Telegram delivery tool first, then present the outcome naturally.`)
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

async function callProviderOnce(config: ProviderConfig, prompt: ReturnType<typeof buildSystemPrompt>, messages: ConversationMessage[], abortSignal: AbortSignal | undefined, isSubAgent: boolean, maxTokens: number | undefined) {
  return await callProvider(config, prompt, messages, abortSignal, isSubAgent, maxTokens)
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

export async function* runAgentLoop(
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
): AsyncGenerator<AgentLoopEvent, AssistantTurnResult> {
  const logger = getLogger(context, options?.logger)
  const startedAt = options?.turnStartedAt ?? Date.now()
  const maxIterations = options?.maxIterations ?? MAX_TURN_ITERATIONS
  const maxTurnDurationMs = options?.maxTurnDurationMs ?? DEFAULT_MAX_TURN_DURATION_MS
  let config = getEffectiveModelConfig()
  const isSubAgent = session.id.startsWith("agent-")
  let activeSession = session
  let compacted = false
  let usage: TurnUsage | undefined
  const steps: AssistantTurnStep[] = []
  const messages = sessionToMessages(session)
  const prompt = buildSystemPrompt({ session: activeSession, rootDir, context, bootstrap: options?.bootstrap, extras: options?.contextExtras, systemPromptOverride: options?.systemPromptOverride })
  let rateLimitAttempts = 0
  let overloadAttempts = 0
  let authAttempts = 0

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    enforceBudgetLimit(options?.costState, config.model)
    yield { type: "setup", sessionId: session.id, iteration, model: config.model, maxIterations, maxTurnDurationMs }
    if (options?.abortSignal?.aborted) {
      const result = finalize("", steps, startedAt, iteration - 1, usage, undefined, "aborted")
      yield { type: "done", sessionId: session.id, result }
      return result
    }
    if (Date.now() - startedAt > maxTurnDurationMs) {
      const result = finalize("", steps, startedAt, iteration - 1, usage, "Turn duration exceeded", "max_duration")
      yield { type: "done", sessionId: session.id, result }
      return result
    }
    try {
      yield { type: "model_invoke_start", sessionId: session.id, iteration, model: config.model }
      const response = await callProviderOnce(config, prompt, messages, options?.abortSignal, isSubAgent, options?.maxTokens)
      enforceBudgetLimit(options?.costState, config.model, response.usage)
      usage = sumUsage(usage, response.usage)
      const loopUsage = response.usage ? {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0),
      } : undefined
      if (response.text) yield { type: "model_stream", sessionId: session.id, iteration, text: redactSensitiveText(response.text) }
      yield { type: "model_invoke_end", sessionId: session.id, iteration, usage: loopUsage, toolCallCount: response.toolCalls.length }
      rateLimitAttempts = 0
      overloadAttempts = 0
      if (response.toolCalls.length === 0) {
        const result = finalize(response.text, steps, startedAt, iteration, usage)
        yield { type: "done", sessionId: session.id, result }
        return result
      }
      const assistantMessage: ConversationMessage = { role: "assistant", content: response.text, toolCalls: response.toolCalls }
      messages.push(assistantMessage)
      for (const toolCall of response.toolCalls) {
        steps.push({ type: "tool", id: toolCall.id, tool: toolCall.name, input: toolCall.input })
      }

      const indexedToolCalls = response.toolCalls.map((toolCall, index) => ({ toolCall, index }))
      const safeToolCalls = indexedToolCalls.filter(({ toolCall }) => isToolConcurrencySafe(toolCall.name, toolCall.input))
      const unsafeToolCalls = indexedToolCalls.filter(({ toolCall }) => !isToolConcurrencySafe(toolCall.name, toolCall.input))
      const toolResults = new Array<{ role: "tool"; toolCallId: string; toolName: string; content: string }>(response.toolCalls.length)

      for (const { toolCall } of safeToolCalls) {
        yield { type: "tool_execute_start", sessionId: session.id, iteration, toolUseId: toolCall.id, tool: toolCall.name, input: toolCall.input }
      }
      const safeResults = await Promise.all(
        safeToolCalls.map(async ({ toolCall, index }) => {
          const result = await executeToolCall(toolCall, executeTool, context)
          return {
            index,
            toolCall,
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
        yield { type: "tool_execute_end", sessionId: session.id, iteration, toolUseId: result.toolCall.id, tool: result.toolCall.name, ok: !result.message.content.includes('status="error"') }
        toolResults[result.index] = result.message
      }

      for (const { toolCall, index } of unsafeToolCalls) {
        yield { type: "tool_execute_start", sessionId: session.id, iteration, toolUseId: toolCall.id, tool: toolCall.name, input: toolCall.input }
        const result = await executeToolCall(toolCall, executeTool, context)
        yield { type: "tool_execute_end", sessionId: session.id, iteration, toolUseId: toolCall.id, tool: toolCall.name, ok: !result.content.includes('status="error"') }
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
      if (options?.abortSignal?.aborted) {
        const result = finalize("", steps, startedAt, Math.max(0, steps.length), usage, undefined, "aborted")
        yield { type: "done", sessionId: session.id, result }
        return result
      }
      if (error instanceof ContextOverflowError && !compacted) {
        yield { type: "recoverable_error", sessionId: session.id, iteration, action: "compact_context", error: error.message }
        compactSession(rootDir, session.id)
        const refreshed = getSession(rootDir, session.id)
        if (refreshed) {
          activeSession = refreshed
          messages.splice(0, messages.length, ...sessionToMessages(refreshed))
        }
        compacted = true
        continue
      }
      if (isAuthError(error) && authAttempts === 0) {
        authAttempts++
        yield { type: "recoverable_error", sessionId: session.id, iteration, action: "reload_auth", error: error instanceof Error ? error.message : String(error) }
        loadAndApplyModelSettings(process.env)
        config = getEffectiveModelConfig()
        continue
      }
      if (error instanceof RateLimitError) {
        rateLimitAttempts++
        overloadAttempts = 0
        if (rateLimitAttempts <= MAX_RATE_LIMIT_RETRIES) {
          const waitMs = error.retryAfterMs ?? Math.min(30_000, 1_000 * 2 ** (rateLimitAttempts - 1))
          yield { type: "recoverable_error", sessionId: session.id, iteration, action: "backoff", error: error.message, retryAfterMs: waitMs }
          await sleep(waitMs, options?.abortSignal)
          continue
        }
      }
      if (error instanceof ProviderOverloadedError || isRetriableNetworkError(error)) {
        overloadAttempts++
        if (overloadAttempts < MAX_OVERLOAD_RETRIES) {
          const waitMs = Math.min(5_000, 750 * 2 ** (overloadAttempts - 1))
          yield { type: "recoverable_error", sessionId: session.id, iteration, action: "backoff", error: error instanceof Error ? error.message : String(error), retryAfterMs: waitMs }
          await sleep(waitMs, options?.abortSignal)
          continue
        }
      }
      if (error instanceof AbortError) throw error
      logger.error("assistant turn failed", { error: error instanceof Error ? error.message : String(error), sessionId: session.id })
      const message = error instanceof Error ? error.message : String(error)
      const result = finalize(message, steps, startedAt, Math.min(maxIterations, steps.length + 1), usage, message)
      yield { type: "done", sessionId: session.id, result }
      return result
    }
  }
  const result = finalize("", steps, startedAt, maxIterations, usage, "Max iterations reached", "max_iterations")
  yield { type: "done", sessionId: session.id, result }
  return result
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
  let finalResult: AssistantTurnResult | null = null
  const generator = runAgentLoop(session, rootDir, executeTool, context, options)
  while (true) {
    const next = await generator.next()
    if (next.done) {
      finalResult = next.value
      break
    }
    const event = next.value as AgentLoopEvent
    if (event.type === "done") finalResult = event.result
  }
  return finalResult ?? finalize("", [], options?.turnStartedAt ?? Date.now(), 0, undefined, "Agent loop finished without a result")
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
