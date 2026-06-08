// MCP result truncation: token-budget aware, simple chars/4 estimator.
// upstream parity: subset del truncateMcpContent. Sin image compression.

export const DEFAULT_TOKEN_BUDGET = 25_000
export const TRUNCATION_MARKER = "\n\n[... truncated, X more chars ...]\n"

export function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

export function mcpContentNeedsTruncation(content: string, budget: number = DEFAULT_TOKEN_BUDGET): boolean {
  return roughTokenCount(content) > budget
}

export function truncateMcpContent(content: string, budget: number = DEFAULT_TOKEN_BUDGET): string {
  if (!mcpContentNeedsTruncation(content, budget)) return content
  const maxChars = budget * 4
  const truncated = content.slice(0, maxChars)
  return `${truncated}${TRUNCATION_MARKER.replace("X", String(content.length - maxChars))}`
}

export function isResultTruncatedByMcp(content: string): boolean {
  return content.includes("[... truncated,") || content.endsWith("...]\n")
}
