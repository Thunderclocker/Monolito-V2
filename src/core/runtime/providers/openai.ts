import { randomUUID } from "node:crypto"
import { parseDirective } from "../directiveParser.ts"
import type { ConversationMessage, ProviderConfig, ProviderResponse } from "./types.ts"
import { parseStructuredToolCalls } from "./types.ts"
import { buildOpenAiMessages, buildToolDefinitions, callJsonApi } from "./utils.ts"

export async function callOpenAiCompatibleApi(
  config: ProviderConfig,
  system: string,
  messages: ConversationMessage[],
  abortSignal: AbortSignal | undefined,
  maxTokens: number | undefined,
  isSubAgent: boolean,
  allowedToolNames?: string[],
  thinkingConfig?: { enabled: boolean; budgetTokens?: number },
): Promise<ProviderResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  }

  if ((config.provider === "xai-oauth" || config.baseUrl.includes("x.ai")) && config.sessionId) {
    headers["x-grok-conv-id"] = config.sessionId
  }

  const isMiniMax = config.provider === "minimax" || config.baseUrl.includes("minimax.io") || config.baseUrl.includes("api.minimax.io")
  const minimaxThinking = isMiniMax && thinkingConfig?.enabled === true

  const data = await callJsonApi(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: buildOpenAiMessages(system, messages),
      tools: buildToolDefinitions(
        isSubAgent,
        messages.slice().reverse().find(m => m.role === "user")?.content || "",
        allowedToolNames
      ).map(tool => ({ type: tool.type, function: tool.function })),

      tool_choice: "auto",
      max_tokens: maxTokens ?? 4_000,
      stream: false,
      ...(minimaxThinking ? {
        extra_body: {
          reasoning_split: true
        }
      } : {}),
    }),
    signal: abortSignal,
  })
  const choice = data.choices?.[0]?.message ?? {}
  const rawContent = typeof choice.content === "string" ? choice.content : ""
  const structured = parseStructuredToolCalls(choice.tool_calls)
  const usage = {
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  }

  let thinking: string | undefined
  if (choice.reasoning_details && Array.isArray(choice.reasoning_details)) {
    thinking = choice.reasoning_details
      .filter((d: any) => d.text)
      .map((d: any) => d.text)
      .join("")
  } else if (typeof choice.reasoning_content === "string") {
    thinking = choice.reasoning_content
  }

  if (structured.length > 0) {
    return { text: rawContent.trim(), toolCalls: structured, thinking, usage }
  }

  const directive = parseDirective(rawContent)
  if (directive?.mode === "tool") {
    const cleaned = rawContent
      .replace(/<(minimax:)?tool_call[\s\S]*?<\/(minimax:)?tool_call>/gi, "")
      .replace(/<invoke[\s\S]*?<\/invoke>/gi, "")
      .trim()
    return {
      text: cleaned,
      toolCalls: [{ id: `xml-${randomUUID().slice(0, 8)}`, name: directive.tool, input: directive.input }],
      thinking,
      usage,
    }
  }
  if (directive?.mode === "tools") {
    return {
      text: "",
      toolCalls: directive.tools.map(t => ({ id: `xml-${randomUUID().slice(0, 8)}`, name: t.tool, input: t.input })),
      thinking,
      usage,
    }
  }

  return { text: rawContent.trim(), toolCalls: [], thinking, usage }
}
