import { appendActionLog, readConfigWing, writeConfigWing } from "../session/store.ts"
import { MONOLITO_ROOT } from "../system/root.ts"

// SearXNG was removed. The web search subsystem now consumes hosted
// provider APIs only (Brave, Serper, Tavily). "default" is a fallback
// that returns a clear "no provider configured" error at the call site.
export type WebSearchProvider = "default" | "brave" | "serper" | "tavily"

export type WebSearchConfig = {
  provider: WebSearchProvider
  apiKey?: string
}

export function readWebSearchConfig(): WebSearchConfig {
  const raw = readConfigWing(MONOLITO_ROOT, "CONF_WEBSEARCH") as Partial<WebSearchConfig>
  const provider = raw.provider
  // Tolerate legacy "searxng" entries silently: drop them to "default"
  // so old configs don't error out. The call site surfaces a clear
  // "no provider configured" message when the user actually tries to
  // search.
  if (provider === "brave" || provider === "serper" || provider === "tavily") {
    return { provider, apiKey: raw.apiKey }
  }
  return { provider: "default" }
}

export function writeWebSearchConfig(config: WebSearchConfig) {
  writeConfigWing(MONOLITO_ROOT, "CONF_WEBSEARCH", config)
  appendActionLog(MONOLITO_ROOT, "Configuracion de websearch actualizada", {
    wing: "CONF_WEBSEARCH",
    provider: config.provider,
  })
}
