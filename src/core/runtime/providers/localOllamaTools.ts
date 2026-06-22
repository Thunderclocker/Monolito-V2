import type Anthropic from "@anthropic-ai/sdk"

export const LOCAL_OLLAMA_MAX_TOOLS = 32

export function localOllamaToolBudget(systemChars: number): number {
  if (systemChars > 12_000) return 14
  if (systemChars > 8_000) return 18
  if (systemChars > 5_000) return 24
  return LOCAL_OLLAMA_MAX_TOOLS
}

/** High-priority tools for local models (Ollama gpt-oss breaks above ~35 tools). */
export const LOCAL_OLLAMA_TOOL_PRIORITY = [
  "Web",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "VisionAnalyze",
  "GenerateImage",
  "GenerateSpeech",
  "TranscribeAudio",
  "Memory",
  "tool_manage_config",
  "Todo",
  "Telegram",
  "TelegramGet",
  "DownloadFile",
  "Mcp",
  "GetSystemStatus",
  "SearchHistory",
  "schedule_task",
] as const

const KEYWORD_TOOL_BOOSTS: Array<{ pattern: RegExp; tools: string[] }> = [
  { pattern: /\b(clima|weather|pronóstico|pronostico|forecast|buscar|search|noticias)\b/i, tools: ["Web"] },
  { pattern: /\b(imagen|foto|image|picture)\b/i, tools: ["Web", "VisionAnalyze", "GenerateImage"] },
  { pattern: /\b(telegram|envi[áa]|mand[áa])\b/i, tools: ["Telegram", "TelegramGet"] },
  { pattern: /\b(git|commit|diff)\b/i, tools: ["Bash"] },
  { pattern: /\b(audio|voz|tts|hablar)\b/i, tools: ["GenerateSpeech", "TranscribeAudio", "VoiceClone"] },
]

export function selectToolsForLocalOllama<T extends { name: string }>(
  tools: T[],
  userText: string,
  budget: number,
): T[] {
  const picked = new Set<string>()
  const result: T[] = []
  const add = (name: string) => {
    if (picked.has(name)) return
    const tool = tools.find(t => t.name === name)
    if (!tool) return
    picked.add(name)
    result.push(tool)
  }
  for (const name of LOCAL_OLLAMA_TOOL_PRIORITY) add(name)
  for (const { pattern, tools: boosted } of KEYWORD_TOOL_BOOSTS) {
    if (!pattern.test(userText)) continue
    for (const name of boosted) add(name)
  }
  for (const tool of tools) {
    if (picked.has(tool.name)) continue
    if (result.length >= budget) break
    add(tool.name)
  }
  return result.slice(0, budget)
}
