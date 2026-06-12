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
  const merged = mergeConsecutiveMessages(messages)
  const result = merged.flatMap<MessageParam>(message => {
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
    if ("toolCalls" in message || message.thinking) {
      const content: any[] = []
      if (message.thinking) {
        content.push({ type: "thinking" as const, thinking: message.thinking })
      }
      if (message.content.trim()) {
        content.push({ type: "text" as const, text: message.content })
      }
      if ("toolCalls" in message) {
        for (const toolCall of message.toolCalls) {
          content.push({ type: "tool_use" as const, id: toolCall.id, name: toolCall.name, input: toolCall.input })
        }
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

  // If the last message is assistant, append a dummy user instruction message to prevent API validation errors and support silence constraint
  if (result.length > 0 && result[result.length - 1].role === "assistant") {
    result.push({
      role: "user",
      content: "[System: Please continue executing the request and call tools if needed. If the user request has already been fully answered by the assistant's previous message (such as a greeting or simple social pleasantry), and there are no further actions or tools to run, you MUST output absolutely nothing (an empty string).]",
    })
  }

  return result
}

export function buildOpenAiMessages(system: string, messages: ConversationMessage[]) {
  const output: Array<Record<string, unknown>> = [{ role: "system", content: system }]
  const merged = mergeConsecutiveMessages(messages)
  for (const message of merged) {
    if (message.role === "tool") {
      output.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content })
      continue
    }
    if ("toolCalls" in message || message.thinking) {
      const assistantMsg: Record<string, any> = {
        role: "assistant",
        content: message.content || "",
      }
      if ("toolCalls" in message) {
        assistantMsg.tool_calls = message.toolCalls.map(toolCall => ({
          id: toolCall.id,
          type: "function",
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) },
        }))
      }
      if (message.thinking) {
        assistantMsg.reasoning_content = message.thinking
        assistantMsg.reasoning_details = [{ text: message.thinking }]
      }
      output.push(assistantMsg)
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

  // If the last message is assistant, append a dummy user/system instruction message to prevent API validation errors
  if (output.length > 0 && output[output.length - 1].role === "assistant") {
    output.push({
      role: "user",
      content: "[System: Please continue executing the request and call tools if needed. If the user request has already been fully answered by the assistant's previous message (such as a greeting or simple social pleasantry), and there are no further actions or tools to run, you MUST output absolutely nothing (an empty string).]",
    })
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

// -----------------------------------------------------------------------------
// Malformed tool-call detector
//
// Symptom observed 2026-06-09 23:21: the model emitted text that looked
// like a tool call but didn't match any parser pattern:
//   "<ListMcpResourcesTool /> <old_string> [ListMcpResourcesTool] </parameter>"
//
// The structured parser (parseStructuredToolCalls) returned nothing, the
// XML directive parser didn't match, and the runtime delivered the
// garbage as a regular assistant message to Telegram. We now flag this
// upstream and let the agent loop re-feed the model with a "re-emit
// using the structured format" prompt instead.
//
// Detection rules — the text:
//   1. Starts with `<` and contains a PascalCase XML tag (looks like a
//      tool call with no body), or
//   2. Contains a known orphan tag (e.g. `</parameter>`, `</invoke>`,
//      `</old_string>`) without its opening pair, or
//   3. Contains a `<toolName ... />` self-closing tag where toolName is
//      one of the registered tool names (e.g. `<Read />`).
//
// This is intentionally conservative: false positives are cheap (we just
// re-feed the model once) and false negatives leak garbage to the user.
// -----------------------------------------------------------------------------

const REGISTERED_TOOL_NAMES = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch",
  "ImageSearch", "TelegramSend", "TelegramSendVoice", "TelegramSendAudio", "TelegramSendPhoto",
  "TelegramSendDocument", "TelegramGetRecentPhotos", "TelegramGetFile", "DownloadFile",
  "TelegramDownloadFile", "GenerateSpeech", "VoiceClone", "VisionAnalyze", "GenerateImage",
  "TranscribeAudio", "SttServiceStatus", "SttServiceDeploy", "SttServiceStop", "SttServiceRemove",
  "SttServiceList", "BootRead", "BootWrite", "ListWings", "CreateWing", "WorkspaceMemoryFiling",
  "WorkspaceMemoryRecall", "KgAdd", "KgInvalidate", "KgQuery", "SessionForensics",
  "AgentSpawn", "AgentSendMessage", "AgentStop", "list_active_workers",
  "delegate_background_task", "TriggerBackgroundStudy", "AgentList", "ProfileCreate",
  "TodoWrite", "TodoList", "QuerySessionStatus", "QueryCost", "QuerySessionStats",
  "CompactSession", "system_status", "system_reboot", "show_master_dashboard",
  "search_tools", "McpInvokeTool", "LspQuery",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "GitStatus", "GitDiff", "GitDiffCached",
  "GitAdd", "GitCommit", "list_files", "pwd", "tool_manage_config", "schedule_task",
]

const ORPHAN_CLOSING_TAGS = [
  "</parameter>", "</invoke>", "</old_string>", "</new_string>",
  "</tool_call>", "</minimax:tool_call>", "</function_calls>",
]

export function looksLikeMalformedToolCall(text: string): boolean {
  if (!text || text.length === 0) return false
  const trimmed = text.trim()
  // Rule 1: starts with `<` and contains a tool-shaped XML tag (PascalCase
  // name possibly with self-closing slash or open-without-close).
  if (trimmed.startsWith("<")) {
    for (const tool of REGISTERED_TOOL_NAMES) {
      if (new RegExp(`^<${tool}\\s*/>`).test(trimmed)) return true
      if (new RegExp(`^<${tool}>\\s*$`).test(trimmed)) return true
    }
  }
  // Self-closing tag where the name is a known tool but not at the
  // very start (e.g. "garbage <Read /> more garbage"). The leading
  // boundary is loose (whitespace or start of string) so the regex
  // matches even when the tag is preceded by a space. This check is
  // outside the `startsWith("<")` block above because the tag may be
  // embedded mid-text.
  if (/(^|\s)<\s*(Read|Edit|Write|Bash|WebFetch|Glob|Grep)\s*\/>/.test(trimmed)) return true
  // Rule 2: orphan closing tags that suggest a previous tool call was
  // truncated or split across the response.
  for (const orphan of ORPHAN_CLOSING_TAGS) {
    if (trimmed.includes(orphan)) return true
  }
  // Rule 3: bracket-only tool call (the JSON form like [Read] or
  // [Bash] with no other content — strong indicator of malformed output).
  if (/^\s*\[\s*(Read|Edit|Write|Bash|Glob|Grep|WebFetch|TelegramSend|TelegramSendPhoto)\s*\]\s*$/.test(trimmed)) {
    return true
  }
  return false
}

export function mergeConsecutiveMessages(messages: ConversationMessage[]): ConversationMessage[] {
  const merged: ConversationMessage[] = []
  for (const msg of messages) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === msg.role && prev.role !== "tool") {
      // Merge content
      const prevContent = prev.content || ""
      const msgContent = msg.content || ""
      prev.content = prevContent && msgContent ? `${prevContent}\n\n${msgContent}` : (prevContent || msgContent)

      // Merge thinking
      const prevAny = prev as any
      const msgAny = msg as any
      if (msgAny.thinking) {
        prevAny.thinking = prevAny.thinking ? `${prevAny.thinking}\n\n${msgAny.thinking}` : msgAny.thinking
      }

      // Merge tool calls
      if ("toolCalls" in msg && msg.toolCalls) {
        if ("toolCalls" in prev) {
          prev.toolCalls = [...(prev.toolCalls || []), ...msg.toolCalls]
        } else {
          (prev as any).toolCalls = msg.toolCalls
        }
      }
    } else {
      // Create a shallow copy to avoid mutating the original objects
      if ("toolCalls" in msg) {
        merged.push({ ...msg, toolCalls: [...msg.toolCalls] } as any)
      } else {
        merged.push({ ...msg } as any)
      }
    }
  }
  return merged
}
