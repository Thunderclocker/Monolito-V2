import type { ContentBlockParam, MessageParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages"

/** Same placeholder as Claude Code (free-code/src/utils/messages.ts). */
export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER = "[Tool result missing due to internal error]"

function asContentBlocks(content: MessageParam["content"]): ContentBlockParam[] {
  if (Array.isArray(content)) return content
  if (typeof content === "string" && content.trim()) {
    return [{ type: "text", text: content }]
  }
  return []
}

/**
 * Claude Code parity: repair tool_use / tool_result pairing before every
 * Messages API call. Prevents 400s from orphaned results, duplicate IDs,
 * or tool_use blocks missing results after compaction / resume.
 */
export function ensureToolResultPairing(messages: MessageParam[]): MessageParam[] {
  const result: MessageParam[] = []
  const allSeenToolUseIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!

    if (msg.role !== "assistant") {
      if (msg.role === "user" && Array.isArray(msg.content) && result.at(-1)?.role !== "assistant") {
        const stripped = msg.content.filter(
          block => !("type" in block && block.type === "tool_result"),
        )
        if (stripped.length !== msg.content.length) {
          const content = stripped.length > 0
            ? stripped
            : result.length === 0
              ? [{ type: "text" as const, text: "[Orphaned tool result removed due to conversation resume]" }]
              : null
          if (content !== null) {
            result.push({ role: "user", content })
          }
          continue
        }
      }
      result.push(msg)
      continue
    }

    const content = asContentBlocks(msg.content)
    const seenToolUseIds = new Set<string>()
    const finalContent = content.filter(block => {
      if (block.type === "tool_use") {
        if (allSeenToolUseIds.has(block.id)) return false
        allSeenToolUseIds.add(block.id)
        seenToolUseIds.add(block.id)
      }
      return true
    })

    if (finalContent.length === 0) {
      finalContent.push({ type: "text", text: "[Tool use interrupted]" })
    }

    result.push({ role: "assistant", content: finalContent })

    const toolUseIds = [...seenToolUseIds]
    const nextMsg = messages[i + 1]
    const existingToolResultIds = new Set<string>()
    let hasDuplicateToolResults = false

    if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
      for (const block of nextMsg.content) {
        if ("type" in block && block.type === "tool_result") {
          const trId = block.tool_use_id
          if (existingToolResultIds.has(trId)) hasDuplicateToolResults = true
          existingToolResultIds.add(trId)
        }
      }
    }

    const toolUseIdSet = new Set(toolUseIds)
    const missingIds = toolUseIds.filter(id => !existingToolResultIds.has(id))
    const orphanedIds = [...existingToolResultIds].filter(id => !toolUseIdSet.has(id))

    if (missingIds.length === 0 && orphanedIds.length === 0 && !hasDuplicateToolResults) {
      continue
    }

    const syntheticBlocks: ToolResultBlockParam[] = missingIds.map(id => ({
      type: "tool_result",
      tool_use_id: id,
      content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
      is_error: true,
    }))

    if (nextMsg?.role === "user") {
      let nextContent = asContentBlocks(nextMsg.content)

      if (orphanedIds.length > 0 || hasDuplicateToolResults) {
        const orphanedSet = new Set(orphanedIds)
        const seenTrIds = new Set<string>()
        nextContent = nextContent.filter(block => {
          if (block.type === "tool_result") {
            if (orphanedSet.has(block.tool_use_id)) return false
            if (seenTrIds.has(block.tool_use_id)) return false
            seenTrIds.add(block.tool_use_id)
          }
          return true
        })
      }

      const patchedContent = [...syntheticBlocks, ...nextContent]
      if (patchedContent.length > 0) {
        result.push({ role: "user", content: patchedContent })
        i++
      } else {
        i++
        result.push({ role: "user", content: [{ type: "text", text: "[System: continuing]" }] })
      }
    } else if (syntheticBlocks.length > 0) {
      result.push({ role: "user", content: syntheticBlocks })
    }
  }

  return result
}
