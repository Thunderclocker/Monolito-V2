import Anthropic from "@anthropic-ai/sdk"
import type { RawMessageStreamEvent, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages"
import type { ConversationMessage, ProviderConfig, ProviderResponse } from "./types.ts"
import { buildAnthropicMessages, buildToolDefinitions, normalizeAnthropicToolInput } from "./utils.ts"

function parsePartialJson(value: string): Record<string, unknown> {
  if (!value.trim()) return {}
  return normalizeAnthropicToolInput(JSON.parse(value))
}

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
    timeout: 600_000,
    dangerouslyAllowBrowser: true,
  })
  const anthropicTools = buildToolDefinitions(isSubAgent).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }))
  const stream = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens ?? 4_000,
    stream: true,
    system: [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ...(bootBlock ? [{ type: "text" as const, text: bootBlock, cache_control: { type: "ephemeral" as const } }] : []),
    ],
    messages: buildAnthropicMessages(messages),
    tools: anthropicTools,
  }, {
    signal: abortSignal,
  })

  const textParts: string[] = []
  const toolBlocks = new Map<number, ToolUseBlock & { inputBuffer?: string }>()
  let usage: ProviderResponse["usage"] | undefined

  for await (const event of stream as AsyncIterable<RawMessageStreamEvent>) {
    if (event.type === "message_start") {
      usage = {
        inputTokens: event.message.usage.input_tokens,
        outputTokens: event.message.usage.output_tokens,
        cacheReadInputTokens: event.message.usage.cache_read_input_tokens,
        cacheCreationInputTokens: event.message.usage.cache_creation_input_tokens,
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
        continue
      }
      if (event.delta.type === "input_json_delta") {
        const toolBlock = toolBlocks.get(event.index)
        if (toolBlock) toolBlock.inputBuffer = `${toolBlock.inputBuffer ?? ""}${event.delta.partial_json}`
      }
      continue
    }

    if (event.type === "content_block_stop") {
      const toolBlock = toolBlocks.get(event.index)
      if (toolBlock) {
        stream.controller.abort()
        break
      }
    }
  }

  const toolCalls = Array.from(toolBlocks.values()).map(block => ({
    id: block.id,
    name: block.name,
    input: parsePartialJson(block.inputBuffer?.trim() ? block.inputBuffer : JSON.stringify(block.input ?? {})),
  }))

  return {
    text: textParts.join("").trim(),
    toolCalls,
    usage,
  }
}
