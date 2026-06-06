import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages"
import { existsSync, readFileSync } from "node:fs"
import { ContextOverflowError, ProviderOverloadedError, RateLimitError } from "../../errors.ts"
import { listModelTools } from "../../tools/registry.ts"
import { normalizeToolInputPayload } from "../toolInput.ts"
import type { ConversationMessage } from "./types.ts"

/**
 * Extracts all photo attachment local_path values from a message content string.
 * Returns an array of { localPath, mediaType } for each detected attachment.
 */
export function extractPhotoAttachments(content: string): Array<{ localPath: string; mediaType: string }> {
  const results: Array<{ localPath: string; mediaType: string }> = []
  const regex = /<attachment\s+kind="photo"[^>]*\blocal_path="([^"]+)"[^>]*\/?\s*>/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    const localPath = match[1]
    const lower = localPath.toLowerCase()
    let mediaType = "image/jpeg"
    if (lower.endsWith(".png")) mediaType = "image/png"
    else if (lower.endsWith(".webp")) mediaType = "image/webp"
    else if (lower.endsWith(".gif")) mediaType = "image/gif"
    results.push({ localPath, mediaType })
  }
  return results
}

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
    // Native multimodal: inject image base64 for user messages with photo attachments
    if (message.role === "user") {
      const attachments = extractPhotoAttachments(message.content)
      const validAttachments = attachments.filter(a => existsSync(a.localPath))
      if (validAttachments.length > 0) {
        const contentBlocks: ContentBlockParam[] = []
        for (const att of validAttachments) {
          try {
            const base64Data = readFileSync(att.localPath).toString("base64")
            contentBlocks.push({
              type: "image",
              source: { type: "base64", media_type: att.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: base64Data },
            })
          } catch {
            // If read fails, skip the image — the model will still see the XML tag
          }
        }
        contentBlocks.push({ type: "text", text: message.content })
        return [{ role: "user" as const, content: contentBlocks }]
      }
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
    // Native multimodal: inject image base64 for user messages with photo attachments
    if (message.role === "user") {
      const attachments = extractPhotoAttachments(message.content)
      const validAttachments = attachments.filter(a => existsSync(a.localPath))
      if (validAttachments.length > 0) {
        const contentParts: Array<Record<string, unknown>> = []
        for (const att of validAttachments) {
          try {
            const base64Data = readFileSync(att.localPath).toString("base64")
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:${att.mediaType};base64,${base64Data}` },
            })
          } catch {
            // If read fails, skip — the model will still see the XML tag
          }
        }
        contentParts.push({ type: "text", text: message.content })
        output.push({ role: "user", content: contentParts })
        continue
      }
    }
    output.push({ role: message.role, content: message.content })
  }
  return output
}

export function buildToolDefinitions(isSubAgent: boolean, lastUserText?: string, allowedToolNames?: string[]) {
  return listModelTools(isSubAgent, lastUserText, allowedToolNames).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
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
