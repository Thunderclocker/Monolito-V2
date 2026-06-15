/** Strip markdown/formatting before TTS; cap length for spoken delivery. */
export function prepareTextForTts(text: string, maxWords = 120): string {
  let out = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  const words = out.split(/\s+/).filter(Boolean)
  if (words.length > maxWords) {
    out = `${words.slice(0, maxWords).join(" ")}…`
  }
  return out
}
