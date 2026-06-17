import { appendActionLog, readConfigWing, writeConfigWing } from "../session/store.ts"
import { MONOLITO_ROOT } from "../system/root.ts"
import { redactSensitiveText } from "../security/redact.ts"

// SearXNG was removed. The web search subsystem now consumes hosted
// provider APIs only (Brave, Serper, Tavily). "default" is a fallback
// that returns a clear "no provider configured" error at the call site.
export type WebSearchProvider = "default" | "brave" | "serper" | "tavily"

export type WebSearchConfig = {
  provider: WebSearchProvider
  apiKey?: string
}

export function readWebSearchConfig(): WebSearchConfig {
  return readWebSearchConfigAt(MONOLITO_ROOT)
}

export function readWebSearchConfigAt(rootDir: string): WebSearchConfig {
  const raw = readConfigWing(rootDir, "CONF_WEBSEARCH") as Partial<WebSearchConfig>
  const provider = raw.provider
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : undefined
  if (provider === "brave" || provider === "serper" || provider === "tavily") {
    return { provider, apiKey: apiKey || undefined }
  }
  // Legacy/partial configs: apiKey saved without provider → Brave is the default hosted API.
  if (apiKey) {
    const fixed = { provider: "brave" as const, apiKey }
    if (provider === "default" || provider === undefined) {
      writeConfigWing(rootDir, "CONF_WEBSEARCH", fixed)
    }
    return fixed
  }
  return { provider: "default" }
}

const HOSTED_WEB_SEARCH_KEY = /\b([A-Za-z0-9_-]{20,64})\b/
const TAVILY_KEY = /\b(tvly-[A-Za-z0-9_-]{10,})\b/i

function extractHostedWebSearchApiKey(text: string): { provider: Exclude<WebSearchProvider, "default">; apiKey: string } | null {
  const stripped = text.replace(/<[^>]+>/g, " ").trim()
  if (!stripped || stripped.length > 500) return null

  const tavily = stripped.match(TAVILY_KEY)
  if (tavily) return { provider: "tavily", apiKey: tavily[1] }

  const lone = stripped.match(/^([A-Za-z0-9_-]{20,64})$/)
  if (lone) return { provider: "brave", apiKey: lone[1] }

  if (/\b(brave|web\s*search|b[uú]squeda|api\s*key|clima|weather)\b/i.test(stripped)) {
    const token = stripped.match(HOSTED_WEB_SEARCH_KEY)
    if (token) return { provider: "brave", apiKey: token[1] }
  }
  return null
}

/** When the user pastes a hosted search API key, persist it without waiting for tool_manage_config. */
export function tryAutoConfigureWebSearchFromUserMessage(text: string): {
  configured: boolean
  redactedText: string
  modelHint?: string
} {
  const current = readWebSearchConfig()
  if (current.provider !== "default") {
    return { configured: false, redactedText: text }
  }

  const extracted = extractHostedWebSearchApiKey(text)
  if (!extracted) return { configured: false, redactedText: text }

  writeWebSearchConfig({ provider: extracted.provider, apiKey: extracted.apiKey })
  const redactedText = redactSensitiveText(text)
  return {
    configured: true,
    redactedText,
    modelHint:
      "CONF_WEBSEARCH was auto-saved from the user's message (provider=" +
      `${extracted.provider}). Call Web action=search now for their pending request. ` +
      "Never repeat API keys or secrets in your reply.",
  }
}

export function writeWebSearchConfig(config: WebSearchConfig) {
  writeConfigWing(MONOLITO_ROOT, "CONF_WEBSEARCH", config)
  appendActionLog(MONOLITO_ROOT, "Configuracion de websearch actualizada", {
    wing: "CONF_WEBSEARCH",
    provider: config.provider,
  })
}
