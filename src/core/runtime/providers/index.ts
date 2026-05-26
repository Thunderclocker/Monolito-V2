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
  let activeConfig = config
  if (config.provider === "xai-oauth") {
    const { resolveGrokAccessToken } = await import("./grokAuth.ts")
    const accessToken = await resolveGrokAccessToken()
    activeConfig = { ...config, apiKey: accessToken }
  }

  if (activeConfig.provider === "anthropic_compatible" || activeConfig.provider === "minimax") {
    return await callAnthropicApi(activeConfig, prompt.system, prompt.bootBlock, messages, abortSignal, maxTokens, isSubAgent, prompt.allowedToolNames)
  }
  if (activeConfig.provider === "ollama") {
    return await callOllamaApi(activeConfig, prompt.system, messages, abortSignal, isSubAgent, prompt.allowedToolNames)
  }
  // Both "xai" and other OpenAI compatible endpoints are routed here
  return await callOpenAiCompatibleApi(activeConfig, prompt.system, messages, abortSignal, maxTokens, isSubAgent, prompt.allowedToolNames)
}

