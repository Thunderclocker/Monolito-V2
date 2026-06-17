import { randomUUID } from "node:crypto"
import { parseDirective } from "../directiveParser.ts"
import type { ConversationMessage, ProviderConfig, ProviderResponse } from "./types.ts"
import { parseStructuredToolCalls } from "./types.ts"
import type { ProviderStreamEvent } from "./streamTypes.ts"
import { buildOpenAiMessages, buildToolDefinitions, callJsonApi, modelSupportsVision, parseProviderErrorResponse } from "./utils.ts"
import { pooledFetch } from "./httpClient.ts"

type OpenAiToolCallAccumulator = {
  id: string
  name: string
  arguments: string
}

function buildOpenAiRequestBody(
  config: ProviderConfig,
  system: string,
  messages: ConversationMessage[],
  isSubAgent: boolean,
  allowedToolNames: string[] | undefined,
  maxTokens: number | undefined,
  stream: boolean,
  thinkingConfig?: { enabled: boolean; budgetTokens?: number },
  strictToolAllowlist?: boolean,
) {
  const isMiniMax = config.provider === "minimax" || config.baseUrl.includes("minimax.io") || config.baseUrl.includes("api.minimax.io")
  const minimaxThinking = isMiniMax && thinkingConfig?.enabled === true
  return {
    model: config.model,
    messages: buildOpenAiMessages(system, messages, {
      supportsVision: modelSupportsVision(config.provider, config.model),
    }),
    tools: buildToolDefinitions(
      isSubAgent,
      messages.slice().reverse().find(m => m.role === "user")?.content || "",
      allowedToolNames,
      strictToolAllowlist,
    ).map(tool => ({ type: tool.type, function: tool.function })),
    tool_choice: "auto",
    max_tokens: maxTokens ?? 4_000,
    stream,
    ...(minimaxThinking ? {
      extra_body: {
        reasoning_split: true,
      },
    } : {}),
  }
}

function buildOpenAiHeaders(config: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  }
  if ((config.provider === "xai-oauth" || config.baseUrl.includes("x.ai")) && config.sessionId) {
    headers["x-grok-conv-id"] = config.sessionId
  }
  return headers
}

function finalizeOpenAiResponse(args: {
  rawContent: string
  toolCalls: OpenAiToolCallAccumulator[]
  thinking?: string
  usage?: ProviderResponse["usage"]
}): ProviderResponse {
  const structured = parseStructuredToolCalls(
    args.toolCalls.map(toolCall => ({
      id: toolCall.id,
      function: { name: toolCall.name, arguments: toolCall.arguments || "{}" },
    })),
  )
  if (structured.length > 0) {
    return { text: args.rawContent.trim(), toolCalls: structured, thinking: args.thinking, usage: args.usage }
  }

  const directive = parseDirective(args.rawContent)
  if (directive?.mode === "tool") {
    const cleaned = args.rawContent
      .replace(/<(minimax:)?tool_call[\s\S]*?<\/(minimax:)?tool_call>/gi, "")
      .replace(/<invoke[\s\S]*?<\/invoke>/gi, "")
      .trim()
    return {
      text: cleaned,
      toolCalls: [{ id: `xml-${randomUUID().slice(0, 8)}`, name: directive.tool, input: directive.input }],
      thinking: args.thinking,
      usage: args.usage,
    }
  }
  if (directive?.mode === "tools") {
    return {
      text: "",
      toolCalls: directive.tools.map(t => ({ id: `xml-${randomUUID().slice(0, 8)}`, name: t.tool, input: t.input })),
      thinking: args.thinking,
      usage: args.usage,
    }
  }

  return { text: args.rawContent.trim(), toolCalls: [], thinking: args.thinking, usage: args.usage }
}

async function* readOpenAiSseStream(
  response: Response,
  abortSignal: AbortSignal | undefined,
): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      if (abortSignal?.aborted) throw abortSignal.reason ?? new Error("Aborted")
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === "[DONE]") continue
        try {
          yield JSON.parse(payload) as Record<string, unknown>
        } catch {
          // Ignore malformed SSE chunks.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function* callOpenAiCompatibleApiStream(
  config: ProviderConfig,
  system: string,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  maxTokens: number | undefined,
  isSubAgent: boolean,
  allowedToolNames?: string[],
  thinkingConfig?: { enabled: boolean; budgetTokens?: number },
  strictToolAllowlist?: boolean,
): AsyncGenerator<ProviderStreamEvent, ProviderResponse> {
  const url = `${config.baseUrl}/v1/chat/completions`
  const headers = buildOpenAiHeaders(config)
  const body = buildOpenAiRequestBody(config, system, messages, isSubAgent, allowedToolNames, maxTokens, true, thinkingConfig, strictToolAllowlist)

  const response = await pooledFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: abortSignal,
  })
  if (!response.ok) {
    await parseProviderErrorResponse(response)
  }

  const textParts: string[] = []
  const thinkingParts: string[] = []
  const toolCalls = new Map<number, OpenAiToolCallAccumulator>()
  let usage: ProviderResponse["usage"] | undefined

  for await (const chunk of readOpenAiSseStream(response, abortSignal)) {
    const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0]
    const delta = choice?.delta as Record<string, unknown> | undefined
    if (!delta) continue

    if (typeof delta.content === "string" && delta.content) {
      textParts.push(delta.content)
      yield { type: "text_delta", text: delta.content }
    }

    const reasoningContent = typeof delta.reasoning_content === "string" ? delta.reasoning_content : ""
    if (reasoningContent) {
      thinkingParts.push(reasoningContent)
      yield { type: "thinking_delta", text: reasoningContent }
    }

    const deltaToolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined
    if (deltaToolCalls) {
      for (const toolCall of deltaToolCalls) {
        const index = typeof toolCall.index === "number" ? toolCall.index : 0
        const current = toolCalls.get(index) ?? {
          id: typeof toolCall.id === "string" ? toolCall.id : `tool-${index}`,
          name: "",
          arguments: "",
        }
        const fn = toolCall.function as Record<string, unknown> | undefined
        if (typeof fn?.name === "string") current.name = fn.name
        if (typeof fn?.arguments === "string") current.arguments += fn.arguments
        toolCalls.set(index, current)
      }
    }

    const chunkUsage = chunk.usage as Record<string, number> | undefined
    if (chunkUsage) {
      usage = {
        inputTokens: chunkUsage.prompt_tokens,
        outputTokens: chunkUsage.completion_tokens,
      }
    }
  }

  const responsePayload = finalizeOpenAiResponse({
    rawContent: textParts.join(""),
    toolCalls: Array.from(toolCalls.values()),
    thinking: thinkingParts.length > 0 ? thinkingParts.join("") : undefined,
    usage,
  })
  yield { type: "done", response: responsePayload }
  return responsePayload
}

export async function callOpenAiCompatibleApi(
  config: ProviderConfig,
  system: string,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  maxTokens: number | undefined,
  isSubAgent: boolean,
  allowedToolNames?: string[],
  thinkingConfig?: { enabled: boolean; budgetTokens?: number },
  strictToolAllowlist?: boolean,
): Promise<ProviderResponse> {
  try {
    const stream = callOpenAiCompatibleApiStream(
      config, system, messages, abortSignal, maxTokens, isSubAgent, allowedToolNames, thinkingConfig, strictToolAllowlist,
    )
    let response: ProviderResponse | undefined
    for await (const event of stream) {
      if (event.type === "done") response = event.response
    }
    if (response) return response
  } catch {
    // Fall back to non-streaming request below.
  }

  const data = await callJsonApi(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: buildOpenAiHeaders(config),
    body: JSON.stringify(buildOpenAiRequestBody(
      config, system, messages, isSubAgent, allowedToolNames, maxTokens, false, thinkingConfig, strictToolAllowlist,
    )),
    signal: abortSignal,
  })
  const choice = data.choices?.[0]?.message ?? {}
  const rawContent = typeof choice.content === "string" ? choice.content : ""
  const usage = {
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  }

  let thinking: string | undefined
  if (choice.reasoning_details && Array.isArray(choice.reasoning_details)) {
    thinking = choice.reasoning_details
      .filter((d: any) => d.text)
      .map((d: any) => d.text)
      .join("")
  } else if (typeof choice.reasoning_content === "string") {
    thinking = choice.reasoning_content
  }

  return finalizeOpenAiResponse({
    rawContent,
    toolCalls: Array.isArray(choice.tool_calls)
      ? choice.tool_calls.map((toolCall: any, index: number) => ({
          id: toolCall.id ?? `tool-${index}`,
          name: toolCall.function?.name ?? "",
          arguments: toolCall.function?.arguments ?? "{}",
        }))
      : [],
    thinking,
    usage,
  })
}
