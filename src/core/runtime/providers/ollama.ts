import type { ConversationMessage, ProviderConfig, ProviderResponse } from "./types.ts"
import { parseStructuredToolCalls } from "./types.ts"
import { buildOpenAiMessages, buildToolDefinitions, callJsonApi, modelSupportsVision } from "./utils.ts"
import { getContextBudget } from "../../context/contextLimits.ts"

export async function callOllamaApi(
  config: ProviderConfig,
  system: string,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  isSubAgent: boolean,
  allowedToolNames?: string[],
): Promise<ProviderResponse> {
  const budget = getContextBudget(config.model)
  const rawMessages = buildOpenAiMessages(system, messages, {
    supportsVision: modelSupportsVision(config.provider, config.model)
  })
  const ollamaMessages = rawMessages.map(msg => {
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
            if (commaIndex !== -1) {
              images.push(url.slice(commaIndex + 1))
            } else {
              images.push(url)
            }
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

  const data = await callJsonApi(`${config.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      messages: ollamaMessages,
      tools: buildToolDefinitions(
        isSubAgent,
        messages.slice().reverse().find(m => m.role === "user")?.content || "",
        allowedToolNames
      ).map(tool => ({ type: tool.type, function: tool.function })),
      options: {
        num_ctx: budget.windowTokens,
      },
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
