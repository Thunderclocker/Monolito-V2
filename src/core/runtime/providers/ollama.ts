import type { ConversationMessage, ProviderConfig, ProviderResponse } from "./types.ts"
import { parseStructuredToolCalls } from "./types.ts"
import { buildOpenAiMessages, buildToolDefinitions, callJsonApi } from "./utils.ts"

export async function callOllamaApi(
  config: ProviderConfig,
  system: string,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  isSubAgent: boolean,
): Promise<ProviderResponse> {
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
