import type { TurnUsage } from "../../cost/tracker.ts"
import type { ModelProvider } from "../modelRegistry.ts"
import { normalizeToolInputPayload } from "../toolInput.ts"

export type ConversationMessage =
  | { role: "user" | "assistant"; content: string; thinking?: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[]; thinking?: string }
  | { role: "tool"; toolCallId: string; toolName: string; content: string }

export type ToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
}

export type ProviderResponse = {
  text: string
  toolCalls: ToolCall[]
  thinking?: string
  usage?: TurnUsage
}

export type ProviderConfig = {
  baseUrl: string
  apiKey: string
  model: string
  provider: ModelProvider
  sessionId?: string
}

export type PromptBlocks = {
  system: string
  /** Cached boot + memory.md block (markdown memory backend). */
  memoryBlock: string
  bootBlock: string
  allowedToolNames?: string[]
  strictToolAllowlist?: boolean
}


let toolCallCounter = 0

export function parseStructuredToolCalls(rawToolCalls: unknown): ToolCall[] {
  if (!Array.isArray(rawToolCalls)) return []
  return rawToolCalls.flatMap<ToolCall>(item => {
    const toolCall = item as { id?: string; function?: { name?: string; arguments?: unknown } }
    if (!toolCall.function?.name) return []
    const rawArgs = toolCall.function.arguments
    try {
      // OpenAI/Anthropic stream `arguments` as a JSON string; Ollama's native
      // /api/chat returns it as an already-parsed object. Handle both so the
      // tool call is not silently dropped (which surfaces as an empty reply).
      const argsObject =
        typeof rawArgs === "string"
          ? JSON.parse(rawArgs || "{}")
          : (rawArgs ?? {})
      const parsed = normalizeToolInputPayload(argsObject)
      // Some providers (Ollama) may omit a call id; synthesize a stable one.
      const id = toolCall.id || `call_${Date.now().toString(36)}_${toolCallCounter++}`
      return [{ id, name: toolCall.function.name, input: parsed as Record<string, unknown> }]
    } catch {
      return []
    }
  })
}
