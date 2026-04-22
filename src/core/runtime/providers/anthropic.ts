import Anthropic from "@anthropic-ai/sdk"
import type { ConversationMessage, ProviderConfig, ProviderResponse } from "./types.ts"
import { buildAnthropicMessages, buildToolDefinitions, normalizeAnthropicToolInput } from "./utils.ts"

export async function callAnthropicApi(
  config: ProviderConfig,
  system: string,
  bootBlock: string,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  maxTokens: number | undefined,
  isSubAgent: boolean,
): Promise<ProviderResponse> {
  const client = new Anthropic({
    apiKey: config.apiKey || "not-needed",
    baseURL: config.baseUrl || undefined,
    dangerouslyAllowBrowser: true,
  })
  const anthropicTools = buildToolDefinitions(isSubAgent).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }))
  const response = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens ?? 4_000,
    system: [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ...(bootBlock ? [{ type: "text" as const, text: bootBlock, cache_control: { type: "ephemeral" as const } }] : []),
    ],
    messages: buildAnthropicMessages(messages),
    tools: anthropicTools,
    abortSignal,
  })
  return {
    text: response.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim(),
    toolCalls: response.content
      .filter(block => block.type === "tool_use")
      .map(block => ({ id: block.id, name: block.name, input: normalizeAnthropicToolInput(block.input) })),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadInputTokens: response.usage.cache_read_input_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
    },
  }
}
