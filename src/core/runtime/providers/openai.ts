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
): Promise<ProviderResponse> {
  const data = await callJsonApi(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: buildOpenAiMessages(system, messages),
      tools: buildToolDefinitions(isSubAgent).map(tool => ({ type: tool.type, function: tool.function })),
      tool_choice: "auto",
      max_tokens: maxTokens ?? 4_000,
      stream: false,
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

  if (structured.length > 0) {
    return { text: rawContent.trim(), toolCalls: structured, usage }
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
      usage,
    }
  }
  if (directive?.mode === "tools") {
    return {
      text: "",
      toolCalls: directive.tools.map(t => ({ id: `xml-${randomUUID().slice(0, 8)}`, name: t.tool, input: t.input })),
      usage,
    }
  }

  return { text: rawContent.trim(), toolCalls: [], usage }
}
