import type { MessageParam } from "@anthropic-ai/sdk/resources/messages"
import { ContextOverflowError, ProviderOverloadedError, RateLimitError } from "../../errors.ts"
import { listModelTools } from "../../tools/registry.ts"
import { normalizeToolInputPayload } from "../toolInput.ts"
import type { ConversationMessage } from "./types.ts"

export function buildAnthropicMessages(messages: ConversationMessage[]): MessageParam[] {
  return messages.flatMap<MessageParam>(message => {
    if (message.role === "tool") {
      return [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
        }],
      }]
    }
    if ("toolCalls" in message) {
      const content = []
      if (message.content.trim()) content.push({ type: "text" as const, text: message.content })
      for (const toolCall of message.toolCalls) {
        content.push({ type: "tool_use" as const, id: toolCall.id, name: toolCall.name, input: toolCall.input })
      }
      return [{ role: "assistant", content }]
    }
    return [{ role: message.role, content: message.content }]
  })
}

export function buildOpenAiMessages(system: string, messages: ConversationMessage[]) {
  const output: Array<Record<string, unknown>> = [{ role: "system", content: system }]
  for (const message of messages) {
    if (message.role === "tool") {
      output.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content })
      continue
    }
    if ("toolCalls" in message) {
      output.push({
        role: "assistant",
        content: message.content || "",
        tool_calls: message.toolCalls.map(toolCall => ({
          id: toolCall.id,
          type: "function",
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) },
        })),
      })
      continue
    }
    output.push({ role: message.role, content: message.content })
  }
  return output
}

export function buildToolDefinitions(isSubAgent: boolean, lastUserText?: string) {
  return listModelTools(isSubAgent, lastUserText).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

async function parseError(response: Response) {
  const text = await response.text()
  const lowered = text.toLowerCase()
  if (response.status === 429 || lowered.includes("rate limit")) throw new RateLimitError(`Rate limit: ${text}`, { statusCode: response.status, responseBody: text, headers: response.headers })
  if (response.status === 529 || response.status === 503) throw new ProviderOverloadedError(`Provider overloaded: ${text}`, { statusCode: response.status, responseBody: text, headers: response.headers })
  if (response.status === 400 || response.status === 413 || lowered.includes("context") || lowered.includes("too many tokens") || lowered.includes("maximum context")) {
    throw new ContextOverflowError(`Context overflow: ${text}`, { statusCode: response.status, responseBody: text, headers: response.headers })
  }
  throw new Error(`Model request failed (${response.status}): ${text}`)
}

export async function callJsonApi(url: string, init: RequestInit) {
  const response = await fetch(url, init)
  if (!response.ok) await parseError(response)
  return await response.json() as Record<string, any>
}

export function normalizeAnthropicToolInput(input: unknown) {
  return normalizeToolInputPayload(input) as Record<string, unknown>
}
