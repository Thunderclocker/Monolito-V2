// MCP result truncation: token-budget aware, simple chars/4 estimator.
// upstream parity: subset del truncateMcpContent. Sin image compression.

export const DEFAULT_TOKEN_BUDGET = 25_000
export const TRUNCATION_MARKER_PREFIX = "\n\n[... truncated, "
export const TRUNCATION_MARKER_SUFFIX = " more chars ...]\n"

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
  const removed = content.length - maxChars
  return `${truncated}${TRUNCATION_MARKER_PREFIX}${removed}${TRUNCATION_MARKER_SUFFIX}`
}

export function isResultTruncatedByMcp(content: string): boolean {
  return content.includes(TRUNCATION_MARKER_PREFIX)
}

/** Verifica si un output arbitrario fue truncado (aplica el contract del tool). */
export function toolOutputTruncated(output: unknown, maxResultSizeChars?: number): boolean {
  if (maxResultSizeChars === undefined) return false
  if (typeof output === "string") {
    return output.length > maxResultSizeChars
  }
  if (Array.isArray(output)) {
    return JSON.stringify(output).length > maxResultSizeChars
  }
  return false
}

/** Aplica truncation a un objeto arbitrario (string, array, object). */
export function truncateMcpResult(result: unknown, budget: number = DEFAULT_TOKEN_BUDGET): {
  truncated: boolean
  result: unknown
  removedChars: number
} {
  if (typeof result === "string") {
    if (!mcpContentNeedsTruncation(result, budget)) {
      return { truncated: false, result, removedChars: 0 }
    }
    const removed = result.length - budget * 4
    return {
      truncated: true,
      result: truncateMcpContent(result, budget),
      removedChars: removed,
    }
  }
  if (Array.isArray(result)) {
    const totalChars = JSON.stringify(result).length
    if (totalChars <= budget * 4) {
      return { truncated: false, result, removedChars: 0 }
    }
    // Truncar el array
    const newResult: unknown[] = []
    let used = 0
    for (const item of result) {
      const itemChars = JSON.stringify(item).length
      if (used + itemChars > budget * 4) break
      newResult.push(item)
      used += itemChars
    }
    return {
      truncated: true,
      result: newResult,
      removedChars: totalChars - used,
    }
  }
  return { truncated: false, result, removedChars: 0 }
}
