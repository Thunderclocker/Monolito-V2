import type { TurnUsage } from "../../cost/tracker.ts"
import type { ModelProvider } from "../modelRegistry.ts"
import { normalizeToolInputPayload } from "../toolInput.ts"

export type ConversationMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string }

export type ToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
}

export type ProviderResponse = {
  text: string
  toolCalls: ToolCall[]
  usage?: TurnUsage
}

export type ProviderConfig = {
  baseUrl: string
  apiKey: string
  model: string
  provider: ModelProvider
}

export type PromptBlocks = {
  system: string
  bootBlock: string
}

export function parseStructuredToolCalls(rawToolCalls: unknown): ToolCall[] {
  if (!Array.isArray(rawToolCalls)) return []
  return rawToolCalls.flatMap<ToolCall>(item => {
    const toolCall = item as { id?: string; function?: { name?: string; arguments?: string } }
    if (!toolCall?.id || !toolCall.function?.name) return []
    try {
      const parsed = normalizeToolInputPayload(JSON.parse(toolCall.function.arguments ?? "{}"))
      return [{ id: toolCall.id, name: toolCall.function.name, input: parsed as Record<string, unknown> }]
    } catch {
      return []
    }
  })
}
