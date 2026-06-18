import type { ConversationMessage, ProviderConfig, ProviderResponse } from "./types.ts"
import { parseStructuredToolCalls } from "./types.ts"
import type { ProviderStreamEvent } from "./streamTypes.ts"
import { buildOpenAiMessages, buildToolDefinitions, callJsonApi, modelSupportsVision } from "./utils.ts"
import { getContextBudget } from "../../context/contextLimits.ts"
import { resolveOllamaResponseText } from "./ollamaText.ts"

function buildOllamaMessages(
  config: ProviderConfig,
  system: string,
  messages: ConversationMessage[],
  isSubAgent: boolean,
  allowedToolNames?: string[],
) {
  const rawMessages = buildOpenAiMessages(system, messages, {
    supportsVision: modelSupportsVision(config.provider, config.model),
  })
  return rawMessages.map(msg => {
    if (Array.isArray(msg.content)) {
      const images: string[] = []
      let text = ""
      for (const part of msg.content) {
        if (typeof part === "object" && part !== null) {
          const p = part as Record<string, any>
          if (p.type === "text") {
            text = p.text || ""
          } else if (p.type === "image_url" && p.image_url && typeof p.image_url.url === "string") {
            const url = p.image_url.url
            const commaIndex = url.indexOf(",")
            images.push(commaIndex !== -1 ? url.slice(commaIndex + 1) : url)
          }
        }
      }
      return {
        ...msg,
        content: text,
        images: images.length > 0 ? images : undefined,
      }
    }
    return msg
  })
}

function buildOllamaBody(
  config: ProviderConfig,
  system: string,
  messages: ConversationMessage[],
  isSubAgent: boolean,
  allowedToolNames: string[] | undefined,
  stream: boolean,
  maxTokens?: number,
  strictToolAllowlist?: boolean,
  thinkingConfig?: { enabled: boolean; budgetTokens?: number },
) {
  const budget = getContextBudget(config.model)
  const numCtx = Math.min(budget.windowTokens, 32_768)
  // Reasoning models (gpt-oss) spend output budget on the analysis channel.
  // Keep a generous floor so reasoning + the final tool_call/content never get
  // truncated mid-flight (which surfaces as an empty assistant reply).
  const numPredict = Math.min(Math.max(maxTokens ?? 8_192, 8_192), numCtx)
  return {
    model: config.model,
    stream,
    // Honor the profile's reasoning level: "off" → think:false so the model
    // does not burn its whole budget on chain-of-thought.
    think: thinkingConfig?.enabled === true,
    messages: buildOllamaMessages(config, system, messages, isSubAgent, allowedToolNames),
    tools: buildToolDefinitions(
      isSubAgent,
      messages.slice().reverse().find(m => m.role === "user")?.content || "",
      allowedToolNames,
      strictToolAllowlist,
    ).map(tool => ({ type: tool.type, function: tool.function })),
    options: {
      num_ctx: numCtx,
      num_predict: numPredict,
    },
  }
}

async function* readNdjsonStream(response: Response, abortSignal: AbortSignal | undefined) {
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
        if (!trimmed) continue
        try {
          yield JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          // Ignore malformed chunks.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function* callOllamaApiStream(
  config: ProviderConfig,
  system: string,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  isSubAgent: boolean,
  allowedToolNames?: string[],
  maxTokens?: number,
  strictToolAllowlist?: boolean,
  thinkingConfig?: { enabled: boolean; budgetTokens?: number },
): AsyncGenerator<ProviderStreamEvent, ProviderResponse> {
  const response = await fetch(`${config.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildOllamaBody(config, system, messages, isSubAgent, allowedToolNames, true, maxTokens, strictToolAllowlist, thinkingConfig)),
    signal: abortSignal,
  })
  if (!response.ok) {
    throw new Error(`Ollama request failed (${response.status})`)
  }

  const textParts: string[] = []
  const thinkingParts: string[] = []
  let toolCalls: ProviderResponse["toolCalls"] = []
  let usage: ProviderResponse["usage"] | undefined

  for await (const chunk of readNdjsonStream(response, abortSignal)) {
    const message = chunk.message as Record<string, unknown> | undefined
    if (typeof message?.content === "string" && message.content) {
      textParts.push(message.content)
      yield { type: "text_delta", text: message.content }
    }
    if (typeof message?.thinking === "string" && message.thinking) {
      thinkingParts.push(message.thinking)
      yield { type: "thinking_delta", text: message.thinking }
    }
    if (Array.isArray(message?.tool_calls)) {
      toolCalls = parseStructuredToolCalls(message.tool_calls)
    }
    usage = {
      inputTokens: chunk.prompt_eval_count as number | undefined,
      outputTokens: chunk.eval_count as number | undefined,
    }
  }

  const resolved = resolveOllamaResponseText(
    textParts.join(""),
    thinkingParts.join(""),
  )
  const responsePayload: ProviderResponse = {
    text: resolved.text,
    toolCalls,
    thinking: resolved.thinking,
    usage,
  }
  yield { type: "done", response: responsePayload }
  return responsePayload
}

export async function callOllamaApi(
  config: ProviderConfig,
  system: string,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  isSubAgent: boolean,
  allowedToolNames?: string[],
  maxTokens?: number,
  strictToolAllowlist?: boolean,
  thinkingConfig?: { enabled: boolean; budgetTokens?: number },
): Promise<ProviderResponse> {
  try {
    const stream = callOllamaApiStream(config, system, messages, abortSignal, isSubAgent, allowedToolNames, maxTokens, strictToolAllowlist, thinkingConfig)
    let response: ProviderResponse | undefined
    for await (const event of stream) {
      if (event.type === "done") response = event.response
    }
    if (response) return response
  } catch {
    // Fall back below.
  }

  const data = await callJsonApi(`${config.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildOllamaBody(config, system, messages, isSubAgent, allowedToolNames, false, maxTokens, strictToolAllowlist, thinkingConfig)),
    signal: abortSignal,
  })

  const message = data.message ?? {}
  const resolved = resolveOllamaResponseText(
    typeof message.content === "string" ? message.content : "",
    typeof message.thinking === "string" ? message.thinking : undefined,
  )
  return {
    text: resolved.text,
    toolCalls: parseStructuredToolCalls(message.tool_calls),
    thinking: resolved.thinking,
    usage: {
      inputTokens: data.prompt_eval_count,
      outputTokens: data.eval_count,
    },
  }
}
