import { callAnthropicApi } from "./anthropic.ts"
import { callOllamaApi } from "./ollama.ts"
import { callOpenAiCompatibleApi } from "./openai.ts"
import type { ConversationMessage, PromptBlocks, ProviderConfig, ProviderResponse, ToolCall } from "./types.ts"

export type { ConversationMessage, PromptBlocks, ProviderConfig, ProviderResponse, ToolCall } from "./types.ts"

export async function callProvider(
  config: ProviderConfig,
  prompt: PromptBlocks,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  isSubAgent: boolean,
  maxTokens?: number,
): Promise<ProviderResponse> {
  if (config.provider === "anthropic_compatible" || config.provider === "minimax") {
    return await callAnthropicApi(config, prompt.system, prompt.bootBlock, messages, abortSignal, maxTokens, isSubAgent)
  }
  if (config.provider === "ollama") {
    return await callOllamaApi(config, prompt.system, messages, abortSignal, isSubAgent)
  }
  return await callOpenAiCompatibleApi(config, prompt.system, messages, abortSignal, maxTokens, isSubAgent)
}
