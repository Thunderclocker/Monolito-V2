import Anthropic from "@anthropic-ai/sdk"
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages"
import { randomUUID } from "node:crypto"
import type { SessionRecord } from "../ipc/protocol.ts"
import { parseDirective } from "./directiveParser.ts"
import { type ToolContext, isToolConcurrencySafe, listModelTools } from "../tools/registry.ts"
import { BOOT_WING_DESCRIPTION, type BootWingEntry } from "../bootstrap/bootWings.ts"
import type { WorkspaceBootstrapContext } from "../context/workspaceContext.ts"
import { type CostState, type TurnUsage } from "../cost/tracker.ts"
import { ContextOverflowError, ProviderOverloadedError, RateLimitError } from "../errors.ts"
import { createLogger, type Logger } from "../logging/logger.ts"
import { readModelSettings } from "./modelConfig.ts"
import { getActiveProfile, type ModelProvider } from "./modelRegistry.ts"
import { normalizeToolInputPayload } from "./toolInput.ts"
import { compactSession, getSession, listCanonicalMemoryEntries } from "../session/store.ts"

const defaultLogger = createLogger("modelAdapterLite")
const MAX_TURN_ITERATIONS = 16
const DEFAULT_MAX_TURN_DURATION_MS = 120_000
const MAX_BACKGROUND_TOKENS = 1_500
const MAX_TOOL_RESULT_CHARS = 20_000
const MAX_RETRIES = 5

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
}

type ConversationMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string }

type ToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
}

type ProviderResponse = {
  text: string
  toolCalls: ToolCall[]
  usage?: TurnUsage
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

function sessionToMessages(session: SessionRecord): ConversationMessage[] {
  return session.messages
    .filter(message => (message.role === "user" || message.role === "assistant") && !shouldSkipMessage(message.text))
    .map(message => ({ role: message.role, content: message.text }))
}

function getLastUserMessage(session: SessionRecord) {
  return session.messages.filter(message => message.role === "user" && !shouldSkipMessage(message.text)).at(-1)?.text ?? ""
}

function truncate(value: string, max: number) {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}\n...[truncated]`
}

function stringifyToolResult(value: unknown) {
  if (typeof value === "string") return truncate(value, MAX_TOOL_RESULT_CHARS)
  try {
    return truncate(JSON.stringify(value, null, 2), MAX_TOOL_RESULT_CHARS)
  } catch {
    return truncate(String(value), MAX_TOOL_RESULT_CHARS)
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
  return {
    finalText,
    steps: [...steps, { type: "final", message: finalText }],
    error,
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

function buildToolSummary(isSubAgent: boolean) {
  return listModelTools(isSubAgent)
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
  const dynamic: string[] = []
  const lastUserMessage = getLastUserMessage(args.session)
  if (lastUserMessage) dynamic.push(`Current user request: ${lastUserMessage}`)
  if (args.extras?.taskNotifications?.length) dynamic.push(`Background updates:\n${args.extras.taskNotifications.map(item => `- ${item}`).join("\n")}`)
  if (args.extras?.dateContext) dynamic.push(args.extras.dateContext)
  if (args.extras?.gitContext) dynamic.push(args.extras.gitContext)
  if (args.extras?.adultMode) dynamic.push("Adult mode is enabled.")
  if (args.extras?.webSearchProvider) dynamic.push(`Web search provider: ${args.extras.webSearchProvider}`)

  return {
    system: [
      "You are Monolito V2, a local assistant with tool access.",
      "Use tools when the answer depends on current files, system state, background worker status, or external resources.",
      "If no tool is needed, answer directly and finish.",
      "Do not describe future work unless the same turn already started it.",
      "Identity and durable user facts:",
      identity,
      `Workspace root: ${args.rootDir}`,
      args.session.id.startsWith("agent-")
        ? "You are a worker. Complete the task directly with the tools available to you."
        : "You may delegate only when it materially helps and the corresponding tool is available.",
      "Available tools:",
      buildToolSummary(args.session.id.startsWith("agent-")),
      dynamic.join("\n\n"),
    ].filter(Boolean).join("\n\n"),
    bootBlock: bootstrap ? describeBootEntries(bootstrap.entries) : "",
  }
}

function buildAnthropicMessages(messages: ConversationMessage[]): MessageParam[] {
  return messages.flatMap<MessageParam>(message => {
    if (message.role === "tool") {
      return [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
        }],
      }]
    }
    if ("toolCalls" in message) {
      const content = []
      if (message.content.trim()) content.push({ type: "text" as const, text: message.content })
      for (const toolCall of message.toolCalls) {
        content.push({ type: "tool_use" as const, id: toolCall.id, name: toolCall.name, input: toolCall.input })
      }
      return [{ role: "assistant", content }]
    }
    return [{ role: message.role, content: message.content }]
  })
}

function buildOpenAiMessages(system: string, messages: ConversationMessage[]) {
  const output: Array<Record<string, unknown>> = [{ role: "system", content: system }]
  for (const message of messages) {
    if (message.role === "tool") {
      output.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content })
      continue
    }
    if ("toolCalls" in message) {
      output.push({
        role: "assistant",
        content: message.content || "",
        tool_calls: message.toolCalls.map(toolCall => ({
          id: toolCall.id,
          type: "function",
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) },
        })),
      })
      continue
    }
    output.push({ role: message.role, content: message.content })
  }
  return output
}

function buildToolDefinitions(isSubAgent: boolean) {
  return listModelTools(isSubAgent).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
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

function parseStructuredToolCalls(rawToolCalls: unknown): ToolCall[] {
  if (!Array.isArray(rawToolCalls)) return []
  return rawToolCalls.flatMap<ToolCall>(item => {
    const toolCall = item as { id?: string; function?: { name?: string; arguments?: string } }
    if (!toolCall?.id || !toolCall.function?.name) return []
    try {
      const parsed = normalizeToolInputPayload(JSON.parse(toolCall.function.arguments ?? "{}"))
      return [{ id: toolCall.id, name: toolCall.function.name, input: parsed as Record<string, unknown> }]
    } catch {
      return []
    }
  })
}

async function parseError(response: Response) {
  const text = await response.text()
  const lowered = text.toLowerCase()
  if (response.status === 429 || lowered.includes("rate limit")) throw new RateLimitError(`Rate limit: ${text}`, { statusCode: response.status, responseBody: text, headers: response.headers })
  if (response.status === 529 || response.status === 503) throw new ProviderOverloadedError(`Provider overloaded: ${text}`, { statusCode: response.status, responseBody: text, headers: response.headers })
  if (response.status === 400 || response.status === 413 || lowered.includes("context") || lowered.includes("too many tokens") || lowered.includes("maximum context")) {
    throw new ContextOverflowError(`Context overflow: ${text}`, { statusCode: response.status, responseBody: text, headers: response.headers })
  }
  throw new Error(`Model request failed (${response.status}): ${text}`)
}

async function callAnthropicApi(config: ReturnType<typeof getEffectiveModelConfig>, system: string, bootBlock: string, messages: ConversationMessage[], abortSignal: AbortSignal | undefined, maxTokens: number | undefined, isSubAgent: boolean): Promise<ProviderResponse> {
  const client = new Anthropic({
    apiKey: config.apiKey || "not-needed",
    baseURL: config.baseUrl || undefined,
    dangerouslyAllowBrowser: true,
  })
  const response = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens ?? 4_000,
    system: [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ...(bootBlock ? [{ type: "text" as const, text: bootBlock, cache_control: { type: "ephemeral" as const } }] : []),
    ],
    messages: buildAnthropicMessages(messages),
    tools: buildToolDefinitions(isSubAgent),
    abortSignal,
  })
  return {
    text: response.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim(),
    toolCalls: response.content
      .filter(block => block.type === "tool_use")
      .map(block => ({ id: block.id, name: block.name, input: normalizeToolInputPayload(block.input) as Record<string, unknown> })),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadInputTokens: response.usage.cache_read_input_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
    },
  }
}

async function callJsonApi(url: string, init: RequestInit) {
  const response = await fetch(url, init)
  if (!response.ok) await parseError(response)
  return await response.json() as Record<string, any>
}

async function callOpenAiCompatibleApi(config: ReturnType<typeof getEffectiveModelConfig>, system: string, messages: ConversationMessage[], abortSignal: AbortSignal | undefined, maxTokens: number | undefined, isSubAgent: boolean): Promise<ProviderResponse> {
  const data = await callJsonApi(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: buildOpenAiMessages(system, messages),
      tools: buildToolDefinitions(isSubAgent).map(tool => ({ type: tool.type, function: tool.function })),
      tool_choice: "auto",
      max_tokens: maxTokens ?? 4_000,
      stream: false,
    }),
    signal: abortSignal,
  })
  const choice = data.choices?.[0]?.message ?? {}
  const rawContent = typeof choice.content === "string" ? choice.content : ""
  const structured = parseStructuredToolCalls(choice.tool_calls)
  const usage = {
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  }

  if (structured.length > 0) {
    return { text: rawContent.trim(), toolCalls: structured, usage }
  }

  // Fallback: algunos providers (ej. MiniMax) devuelven tool calls como XML embebido en el contenido.
  const directive = parseDirective(rawContent)
  if (directive?.mode === "tool") {
    const cleaned = rawContent
      .replace(/<(minimax:)?tool_call[\s\S]*?<\/(minimax:)?tool_call>/gi, "")
      .replace(/<invoke[\s\S]*?<\/invoke>/gi, "")
      .trim()
    return {
      text: cleaned,
      toolCalls: [{ id: `xml-${randomUUID().slice(0, 8)}`, name: directive.tool, input: directive.input }],
      usage,
    }
  }
  if (directive?.mode === "tools") {
    return {
      text: "",
      toolCalls: directive.tools.map(t => ({ id: `xml-${randomUUID().slice(0, 8)}`, name: t.tool, input: t.input })),
      usage,
    }
  }

  return { text: rawContent.trim(), toolCalls: [], usage }
}

async function callOllamaApi(config: ReturnType<typeof getEffectiveModelConfig>, system: string, messages: ConversationMessage[], abortSignal: AbortSignal | undefined, isSubAgent: boolean): Promise<ProviderResponse> {
  const data = await callJsonApi(`${config.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      messages: buildOpenAiMessages(system, messages),
      tools: buildToolDefinitions(isSubAgent).map(tool => ({ type: tool.type, function: tool.function })),
    }),
    signal: abortSignal,
  })
  const message = data.message ?? {}
  return {
    text: typeof message.content === "string" ? message.content.trim() : "",
    toolCalls: parseStructuredToolCalls(message.tool_calls),
    usage: {
      inputTokens: data.prompt_eval_count,
      outputTokens: data.eval_count,
    },
  }
}

async function callProvider(config: ReturnType<typeof getEffectiveModelConfig>, prompt: ReturnType<typeof buildSystemPrompt>, messages: ConversationMessage[], abortSignal: AbortSignal | undefined, isSubAgent: boolean, maxTokens?: number) {
  if (config.provider === "anthropic_compatible") return await callAnthropicApi(config, prompt.system, prompt.bootBlock, messages, abortSignal, maxTokens, isSubAgent)
  if (config.provider === "ollama") return await callOllamaApi(config, prompt.system, messages, abortSignal, isSubAgent)
  return await callOpenAiCompatibleApi(config, prompt.system, messages, abortSignal, maxTokens, isSubAgent)
}

async function callProviderWithRetry(config: ReturnType<typeof getEffectiveModelConfig>, prompt: ReturnType<typeof buildSystemPrompt>, messages: ConversationMessage[], abortSignal: AbortSignal | undefined, isSubAgent: boolean, maxTokens: number | undefined) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await callProvider(config, prompt, messages, abortSignal, isSubAgent, maxTokens)
    } catch (error) {
      if (abortSignal?.aborted) throw abortSignal.reason ?? error
      if (error instanceof RateLimitError || error instanceof ProviderOverloadedError) {
        if (attempt === MAX_RETRIES - 1) throw error
        await sleep(Math.min(30_000, 1_000 * 2 ** attempt), abortSignal)
        continue
      }
      throw error
    }
  }
  throw new Error("Unreachable retry state")
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
    if (options?.abortSignal?.aborted) return finalize("", steps, startedAt, iteration - 1, usage, undefined, "aborted")
    if (Date.now() - startedAt > maxTurnDurationMs) return finalize("", steps, startedAt, iteration - 1, usage, "Turn duration exceeded", "max_duration")
    try {
      const response = await callProviderWithRetry(config, prompt, messages, options?.abortSignal, isSubAgent, undefined)
      usage = sumUsage(usage, response.usage)
      if (response.toolCalls.length === 0) return finalize(response.text, steps, startedAt, iteration, usage)
      const assistantMessage: ConversationMessage = { role: "assistant", content: response.text, toolCalls: response.toolCalls }
      messages.push(assistantMessage)
      for (const toolCall of response.toolCalls) {
        steps.push({ type: "tool", id: toolCall.id, tool: toolCall.name, input: toolCall.input })
        try {
          const output = await executeTool(toolCall.name, toolCall.input, context, toolCall.id)
          messages.push({ role: "tool", toolCallId: toolCall.id, toolName: toolCall.name, content: stringifyToolResult(output) })
        } catch (error) {
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: stringifyToolResult({ error: error instanceof Error ? error.message : String(error) }),
          })
        }
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
