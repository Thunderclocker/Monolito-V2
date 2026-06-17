import type { ProviderConfig } from "./providers/types.ts"
import { isLocalOllamaAnthropicBackend } from "./providers/resolveProvider.ts"

/**
 * Claude Code parity: small eager tool surface on the API wire; full registry
 * remains executable. Deferred tools are discovered via search_tools.
 */
export const EAGER_TOOL_NAMES = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Web",
  "Todo",
  "search_tools",
  "Mcp",
  "Boot",
  "Memory",
  "tool_manage_config",
  "VisionAnalyze",
  "GenerateSpeech",
  "TranscribeAudio",
  "QueryRuntime",
] as const

const TELEGRAM_EAGER = [
  "Telegram",
  "TelegramGet",
  "DownloadFile",
] as const

const KEYWORD_TOOL_BOOSTS: Array<{ pattern: RegExp; tools: string[] }> = [
  { pattern: /\b(clima|weather|pronóstico|pronostico|forecast|buscar|search|noticias)\b/i, tools: ["Web"] },
  { pattern: /\b(imagen|foto|image|picture)\b/i, tools: ["Web", "VisionAnalyze", "GenerateImage", "Telegram"] },
  { pattern: /\b(telegram|envi[áa]|mand[áa])\b/i, tools: ["Telegram", "GenerateSpeech"] },
  { pattern: /\b(git|commit|diff|stash|branch)\b/i, tools: ["Bash"] },
  { pattern: /\b(audio|voz|tts|hablar|transcri)/i, tools: ["GenerateSpeech", "TranscribeAudio", "VoiceClone"] },
  { pattern: /\b(memoria|memory|boot|recordar)\b/i, tools: ["Boot", "Memory"] },
  { pattern: /\b(costo|cost|usage|tokens)\b/i, tools: ["QueryRuntime"] },
  { pattern: /\b(daemon|reinici|reboot|servicio|system)\b/i, tools: ["system_status", "system_reboot"] },
  { pattern: /\b(forensic|worklog|auditor)/i, tools: ["SessionForensics", "SearchHistory"] },
  { pattern: /\b(compact|contexto|context)\b/i, tools: ["CompactSession"] },
  { pattern: /\b(kg|knowledge graph|grafo)\b/i, tools: ["Kg"] },
]

/** When true, only eager + unlocked tools go to the model API (execution stays full registry). */
export function shouldUseTieredToolExposure(config: ProviderConfig, totalToolCount: number): boolean {
  if (process.env.MONOLITO_FULL_TOOL_EXPOSURE === "1") return false
  if (isLocalOllamaAnthropicBackend(config)) return true
  if (totalToolCount > 28) return true
  return process.env.MONOLITO_TIERED_TOOLS === "1"
}

export function boostToolsFromUserText(userText: string): string[] {
  const boosted: string[] = []
  for (const { pattern, tools } of KEYWORD_TOOL_BOOSTS) {
    if (pattern.test(userText)) boosted.push(...tools)
  }
  return boosted
}

/** Parse tool names from search_tools output lines like `- [native] GitStatus (...)`. */
export function unlockToolsFromSearchResult(content: string): string[] {
  const names: string[] = []
  for (const line of content.split("\n")) {
    const m = line.match(/^-\s\[(?:native|mcp)\]\s+([A-Za-z0-9_]+)\s+\(/)
    if (m?.[1]) names.push(m[1])
  }
  return names
}

export function buildInitialApiToolAllowlist(options: {
  lastUserText: string
  isTelegramChannel: boolean
  sessionUnlocked?: Iterable<string>
}): string[] {
  const set = new Set<string>(EAGER_TOOL_NAMES)
  if (options.isTelegramChannel) {
    for (const name of TELEGRAM_EAGER) set.add(name)
  }
  for (const name of boostToolsFromUserText(options.lastUserText)) set.add(name)
  for (const name of options.sessionUnlocked ?? []) set.add(name)
  return [...set]
}

export function mergeApiToolAllowlist(current: string[], additions: Iterable<string>): string[] {
  return [...new Set([...current, ...additions])]
}
