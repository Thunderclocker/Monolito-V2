/**
 * gpt-oss (and similar Ollama models) split output into `content` (user-facing,
 * the "final" harmony channel) and `thinking` (chain-of-thought, the "analysis"
 * channel). The user-facing reply always lands in `content`. When `content` is
 * empty the model either emitted a tool call or produced nothing deliverable —
 * the runtime handles both. We must NOT scrape the chain-of-thought for a reply:
 * doing so leaks raw reasoning fragments (e.g. a quoted instruction line) to the
 * user as if it were the answer.
 */

export function resolveOllamaResponseText(
  content: string,
  thinking?: string,
): { text: string; thinking?: string } {
  return {
    text: content?.trim() ?? "",
    thinking: thinking?.trim() || undefined,
  }
}
