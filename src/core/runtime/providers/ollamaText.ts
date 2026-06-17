/**
 * gpt-oss (and similar Ollama models) split output into `content` (user-facing)
 * and `thinking` (chain-of-thought). Monolito must read both: when `content`
 * is empty the intended reply often lives inside `thinking`.
 */

/** Extract a user-facing reply embedded in model thinking (gpt-oss pattern). */
export function extractUserFacingTextFromThinking(thinking: string): string | null {
  if (!thinking?.trim()) return null
  const t = thinking.trim()

  const respondPatterns = [
    /(?:let'?s respond|should respond|respond(?:ir)?|reply)(?:\s+with)?[^"\n]{0,60}:\s*["“]([^"”\n]+)["”]/gi,
    /(?:final(?:ly)?|so),?\s*["“]([^"”\n]{4,})["”]\s*$/gim,
  ]
  for (const pattern of respondPatterns) {
    const matches = [...t.matchAll(pattern)]
    if (matches.length > 0) {
      const candidate = matches[matches.length - 1]![1]!.trim()
      if (candidate.length >= 3) return candidate
    }
  }

  const quotes = [...t.matchAll(/["“]([^"”\n]{4,})["”]/g)]
  for (let i = quotes.length - 1; i >= 0; i--) {
    const candidate = quotes[i]![1]!.trim()
    if (/^(me llamo|my name is)\b/i.test(candidate) && candidate.length < 50) continue
    if (/[.!?¿¡]/.test(candidate) || candidate.split(/\s+/).length >= 3) return candidate
  }

  return null
}

export function resolveOllamaResponseText(
  content: string,
  thinking?: string,
): { text: string; thinking?: string } {
  const trimmedContent = content?.trim() ?? ""
  const trimmedThinking = thinking?.trim() || undefined

  if (trimmedContent) {
    return { text: trimmedContent, thinking: trimmedThinking }
  }

  const extracted = trimmedThinking ? extractUserFacingTextFromThinking(trimmedThinking) : null
  if (extracted) {
    return { text: extracted, thinking: trimmedThinking }
  }

  return { text: "", thinking: trimmedThinking }
}
