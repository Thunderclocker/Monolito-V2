import { callAnthropicApi, callAnthropicApiStream } from "./anthropic.ts"
import { callOllamaApiStream } from "./ollama.ts"
import { callOpenAiCompatibleApi, callOpenAiCompatibleApiStream } from "./openai.ts"
import { isOllamaLocalBaseUrl, resolveChatProviderConfig } from "./resolveProvider.ts"
import type { ProviderStreamEvent } from "./streamTypes.ts"
import type { ConversationMessage, PromptBlocks, ProviderConfig, ProviderResponse, ToolCall } from "./types.ts"

export type { ConversationMessage, PromptBlocks, ProviderConfig, ProviderResponse, ToolCall } from "./types.ts"
export type { ProviderStreamEvent } from "./streamTypes.ts"

export async function* callProviderStream(
  config: ProviderConfig,
  prompt: PromptBlocks,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  isSubAgent: boolean,
  maxTokens?: number,
  thinkingConfig?: { enabled: boolean; budgetTokens?: number; level?: "low" | "medium" | "high" | "off" },
): AsyncGenerator<ProviderStreamEvent, ProviderResponse> {
  const mergedSystem = [prompt.system, prompt.memoryBlock, prompt.bootBlock].filter(Boolean).join("\n\n")

  // Native Ollama /api/chat sets num_ctx and avoids the /v1/messages ~4K silent truncate.
  if (config.provider === "ollama" || isOllamaLocalBaseUrl(config.baseUrl)) {
    return yield* callOllamaApiStream(
      config,
      mergedSystem,
      messages,
      abortSignal,
      isSubAgent,
      prompt.allowedToolNames,
      maxTokens,
      prompt.strictToolAllowlist,
      thinkingConfig,
    )
  }

  let activeConfig = resolveChatProviderConfig(config)
  if (activeConfig.provider === "xai-oauth") {
    const { resolveGrokAccessToken } = await import("./grokAuth.ts")
    const accessToken = await resolveGrokAccessToken()
    activeConfig = { ...activeConfig, apiKey: accessToken }
  }

  if (activeConfig.provider === "anthropic_compatible" || activeConfig.provider === "minimax") {
    return yield* callAnthropicApiStream(
      activeConfig, prompt.system, prompt.memoryBlock, prompt.bootBlock, messages, abortSignal, maxTokens, isSubAgent, prompt.allowedToolNames, thinkingConfig, prompt.strictToolAllowlist,
    )
  }
  return yield* callOpenAiCompatibleApiStream(
    activeConfig, mergedSystem, messages, abortSignal, maxTokens, isSubAgent, prompt.allowedToolNames, thinkingConfig, prompt.strictToolAllowlist,
  )
}

export async function callProvider(
  config: ProviderConfig,
  prompt: PromptBlocks,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  isSubAgent: boolean,
  maxTokens?: number,
  thinkingConfig?: { enabled: boolean; budgetTokens?: number; level?: "low" | "medium" | "high" | "off" },
): Promise<ProviderResponse> {
  const stream = callProviderStream(config, prompt, messages, abortSignal, isSubAgent, maxTokens, thinkingConfig)
  let response: ProviderResponse | undefined
  for await (const event of stream) {
    if (event.type === "done") response = event.response
  }
  if (!response) throw new Error("Provider stream completed without a response")
  return response
}
