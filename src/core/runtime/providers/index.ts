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
  thinkingConfig?: { enabled: boolean; budgetTokens?: number },
): Promise<ProviderResponse> {
  let activeConfig = config
  if (config.provider === "xai-oauth") {
    const { resolveGrokAccessToken } = await import("./grokAuth.ts")
    const accessToken = await resolveGrokAccessToken()
    activeConfig = { ...config, apiKey: accessToken }
  }

  if (activeConfig.provider === "anthropic_compatible" || activeConfig.provider === "minimax") {
    return await callAnthropicApi(activeConfig, prompt.system, prompt.memoryBlock, prompt.bootBlock, messages, abortSignal, maxTokens, isSubAgent, prompt.allowedToolNames, thinkingConfig)
  }
  if (activeConfig.provider === "ollama") {
    const mergedSystem = [prompt.system, prompt.memoryBlock].filter(Boolean).join("\n\n")
    return await callOllamaApi(activeConfig, mergedSystem, messages, abortSignal, isSubAgent, prompt.allowedToolNames)
  }
  const mergedSystem = [prompt.system, prompt.memoryBlock].filter(Boolean).join("\n\n")
  // Both "xai" and other OpenAI compatible endpoints are routed here
  return await callOpenAiCompatibleApi(activeConfig, mergedSystem, messages, abortSignal, maxTokens, isSubAgent, prompt.allowedToolNames, thinkingConfig)
}

