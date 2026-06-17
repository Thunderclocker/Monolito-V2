import Anthropic from "@anthropic-ai/sdk"
import type { ToolUseBlock } from "@anthropic-ai/sdk/resources/messages"
import type { ConversationMessage, ProviderConfig, ProviderResponse } from "./types.ts"
import type { ProviderStreamEvent } from "./streamTypes.ts"
import { buildAnthropicMessages, buildToolDefinitions, normalizeAnthropicToolInput } from "./utils.ts"
import { isLocalOllamaAnthropicBackend } from "./resolveProvider.ts"
import { ensureToolResultPairing } from "./ensureToolResultPairing.ts"
import { selectToolsForLocalOllama, localOllamaToolBudget } from "./localOllamaTools.ts"

function parsePartialJson(value: string): Record<string, unknown> {
  if (!value.trim()) return {}
  try {
    return normalizeAnthropicToolInput(JSON.parse(value))
  } catch {
    return {}
  }
}

function sanitizeAnthropicBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/v1\/messages\/?$/, "")
}

const anthropicClients = new Map<string, Anthropic>()

function getAnthropicClient(config: ProviderConfig): Anthropic {
  const cleanBaseUrl = config.baseUrl ? sanitizeAnthropicBaseUrl(config.baseUrl) : ""
  const key = `${cleanBaseUrl}|${config.apiKey}`
  let client = anthropicClients.get(key)
  if (!client) {
    client = new Anthropic({
      apiKey: config.apiKey || "not-needed",
      baseURL: cleanBaseUrl || undefined,
      timeout: 600_000,
      dangerouslyAllowBrowser: true,
    })
    anthropicClients.set(key, client)
  }
  return client
}

export async function* callAnthropicApiStream(
  config: ProviderConfig,
  system: string,
  memoryBlock: string,
  bootBlock: string,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  maxTokens: number | undefined,
  isSubAgent: boolean,
  allowedToolNames?: string[],
  thinkingConfig?: { enabled: boolean; budgetTokens?: number },
  strictToolAllowlist?: boolean,
): AsyncGenerator<ProviderStreamEvent, ProviderResponse> {
  const client = getAnthropicClient(config)
  const lastUserText = messages.slice().reverse().find(m => m.role === "user")?.content || ""
  const localOllama = isLocalOllamaAnthropicBackend(config)
  const rawTools = buildToolDefinitions(
    isSubAgent,
    lastUserText,
    allowedToolNames,
    strictToolAllowlist,
  ).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }))
  const systemChars = system.length + memoryBlock.length + bootBlock.length
  const anthropicTools = localOllama && rawTools.length > localOllamaToolBudget(systemChars)
    ? selectToolsForLocalOllama(rawTools, lastUserText, localOllamaToolBudget(systemChars))
    : rawTools

  const thinkingEnabled = thinkingConfig?.enabled === true
  const thinkingBudget = thinkingConfig?.budgetTokens ?? 4_000
  const activeMaxTokens = thinkingEnabled ? Math.max(maxTokens ?? 8_000, thinkingBudget + 4_000) : (maxTokens ?? 4_000)

  const systemBlocks = localOllama
    ? [{ type: "text" as const, text: [system, memoryBlock, bootBlock].filter(Boolean).join("\n\n") }]
    : [
      { type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } },
      ...(memoryBlock ? [{ type: "text" as const, text: memoryBlock, cache_control: { type: "ephemeral" as const } }] : []),
      ...(bootBlock ? [{ type: "text" as const, text: bootBlock, cache_control: { type: "ephemeral" as const } }] : []),
    ]

  const stream = await client.messages.create({
    model: config.model,
    max_tokens: activeMaxTokens,
    stream: true,
    system: systemBlocks,
    messages: ensureToolResultPairing(buildAnthropicMessages(messages)),
    tools: anthropicTools,
    ...(thinkingEnabled ? {
      thinking: { type: "enabled", budget_tokens: thinkingBudget },
    } : {}),
  }, {
    signal: abortSignal,
  })

  const textParts: string[] = []
  const thinkingParts: string[] = []
  const toolBlocks = new Map<number, ToolUseBlock & { inputBuffer?: string }>()
  let usage: ProviderResponse["usage"] | undefined

  for await (const event of stream as AsyncIterable<any>) {
    if (event.type === "message_start") {
      usage = {
        inputTokens: event.message.usage.input_tokens,
        outputTokens: event.message.usage.output_tokens,
        cacheReadInputTokens: event.message.usage.cache_read_input_tokens ?? undefined,
        cacheCreationInputTokens: event.message.usage.cache_creation_input_tokens ?? undefined,
      }
      continue
    }

    if (event.type === "message_delta") {
      usage = {
        ...(usage ?? {}),
        outputTokens: event.usage.output_tokens,
      }
      continue
    }

    if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      toolBlocks.set(event.index, { ...event.content_block, inputBuffer: "" })
      continue
    }

    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") {
        textParts.push(event.delta.text)
        yield { type: "text_delta", text: event.delta.text }
        continue
      }
      if (event.delta.type === "thinking_delta") {
        thinkingParts.push(event.delta.thinking)
        yield { type: "thinking_delta", text: event.delta.thinking }
        continue
      }
      if (event.delta.type === "input_json_delta") {
        const toolBlock = toolBlocks.get(event.index)
        if (toolBlock) toolBlock.inputBuffer = `${toolBlock.inputBuffer ?? ""}${event.delta.partial_json}`
      }
      continue
    }
  }

  const toolCalls = Array.from(toolBlocks.values()).map(block => ({
    id: block.id,
    name: block.name,
    input: parsePartialJson(block.inputBuffer?.trim() ? block.inputBuffer : JSON.stringify(block.input ?? {})),
  }))

  const response: ProviderResponse = {
    text: textParts.join("").trim(),
    toolCalls,
    thinking: thinkingParts.length > 0 ? thinkingParts.join("") : undefined,
    usage,
  }
  yield { type: "done", response }
  return response
}

export async function callAnthropicApi(
  config: ProviderConfig,
  system: string,
  memoryBlock: string,
  bootBlock: string,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  maxTokens: number | undefined,
  isSubAgent: boolean,
  allowedToolNames?: string[],
  thinkingConfig?: { enabled: boolean; budgetTokens?: number },
  strictToolAllowlist?: boolean,
): Promise<ProviderResponse> {
  const stream = callAnthropicApiStream(
    config, system, memoryBlock, bootBlock, messages, abortSignal, maxTokens, isSubAgent, allowedToolNames, thinkingConfig, strictToolAllowlist,
  )
  let response: ProviderResponse | undefined
  for await (const event of stream) {
    if (event.type === "done") response = event.response
  }
  if (!response) throw new Error("Anthropic stream completed without a response")
  return response
}
