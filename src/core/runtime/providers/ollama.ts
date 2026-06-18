import type { ConversationMessage, ProviderConfig, ProviderResponse } from "./types.ts"
import { parseStructuredToolCalls } from "./types.ts"
import type { ProviderStreamEvent } from "./streamTypes.ts"
import { buildOpenAiMessages, buildToolDefinitions, callJsonApi, modelSupportsVision } from "./utils.ts"
import { getContextBudget } from "../../context/contextLimits.ts"
import { resolveOllamaResponseText } from "./ollamaText.ts"

/**
 * Reasoning-first local models that expose the harmony analysis/final channels.
 * For these, `think:false` is harmful (no tool_calls / empty final), so the
 * effective floor is "low" even when the profile reasoning level is "off".
 */
function isReasoningModel(model: string): boolean {
  return /gpt-oss|deepseek-r1|\br1\b|qwen3|qwq|magistral|phi-?4-reasoning/i.test(model)
}

export function resolveOllamaThink(
  model: string,
  thinkingConfig?: { enabled: boolean; budgetTokens?: number; level?: "low" | "medium" | "high" | "off" },
): boolean | "low" | "medium" | "high" {
  if (thinkingConfig?.enabled === true && thinkingConfig.level && thinkingConfig.level !== "off") {
    return thinkingConfig.level
  }
  // Disabled / "off": keep a minimal "low" floor for reasoning models so the
  // analysis→final/tool flow completes; truly disable for the rest.
  return isReasoningModel(model) ? "low" : false
}

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
  thinkingConfig?: { enabled: boolean; budgetTokens?: number; level?: "low" | "medium" | "high" | "off" },
) {
  const budget = getContextBudget(config.model)
  const numCtx = Math.min(budget.windowTokens, 32_768)
  // Reasoning models (gpt-oss) spend output budget on the analysis channel.
  // Keep a generous floor so reasoning + the final tool_call/content never get
  // truncated mid-flight (which surfaces as an empty assistant reply).
  const numPredict = Math.min(Math.max(maxTokens ?? 8_192, 8_192), numCtx)
  // Honor the profile's reasoning level via Ollama's granular `think` effort.
  // Reasoning models (gpt-oss et al.) DEGRADE with think:false — the harmony
  // template stalls in the analysis channel and never emits a final answer or
  // tool_call (observed: empty replies / no BootWrite during onboarding). So
  // for those models we clamp the floor to "low" instead of disabling.
  const think = resolveOllamaThink(config.model, thinkingConfig)
  return {
    model: config.model,
    stream,
    think,
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
  thinkingConfig?: { enabled: boolean; budgetTokens?: number; level?: "low" | "medium" | "high" | "off" },
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
  thinkingConfig?: { enabled: boolean; budgetTokens?: number; level?: "low" | "medium" | "high" | "off" },
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
