import { callAnthropicApi, callAnthropicApiStream } from "./anthropic.ts"
import { callOllamaApi, callOllamaApiStream } from "./ollama.ts"
import { callOpenAiCompatibleApi, callOpenAiCompatibleApiStream } from "./openai.ts"
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
  thinkingConfig?: { enabled: boolean; budgetTokens?: number },
): AsyncGenerator<ProviderStreamEvent, ProviderResponse> {
  let activeConfig = config
  if (config.provider === "xai-oauth") {
    const { resolveGrokAccessToken } = await import("./grokAuth.ts")
    const accessToken = await resolveGrokAccessToken()
    activeConfig = { ...config, apiKey: accessToken }
  }

  if (activeConfig.provider === "anthropic_compatible" || activeConfig.provider === "minimax") {
    return yield* callAnthropicApiStream(
      activeConfig, prompt.system, prompt.memoryBlock, prompt.bootBlock, messages, abortSignal, maxTokens, isSubAgent, prompt.allowedToolNames, thinkingConfig,
    )
  }
  if (activeConfig.provider === "ollama") {
    const mergedSystem = [prompt.system, prompt.memoryBlock, prompt.bootBlock].filter(Boolean).join("\n\n")
    return yield* callOllamaApiStream(activeConfig, mergedSystem, messages, abortSignal, isSubAgent, prompt.allowedToolNames)
  }
  const mergedSystem = [prompt.system, prompt.memoryBlock, prompt.bootBlock].filter(Boolean).join("\n\n")
  return yield* callOpenAiCompatibleApiStream(
    activeConfig, mergedSystem, messages, abortSignal, maxTokens, isSubAgent, prompt.allowedToolNames, thinkingConfig,
  )
}

export async function callProvider(
  config: ProviderConfig,
  prompt: PromptBlocks,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  isSubAgent: boolean,
  maxTokens?: number,
  thinkingConfig?: { enabled: boolean; budgetTokens?: number },
): Promise<ProviderResponse> {
  const stream = callProviderStream(config, prompt, messages, abortSignal, isSubAgent, maxTokens, thinkingConfig)
  let response: ProviderResponse | undefined
  for await (const event of stream) {
    if (event.type === "done") response = event.response
  }
  if (!response) throw new Error("Provider stream completed without a response")
  return response
}
