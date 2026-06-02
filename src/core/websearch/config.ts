import { appendActionLog, readConfigWing, writeConfigWing } from "../session/store.ts"
import { MONOLITO_ROOT } from "../system/root.ts"

export type WebSearchProvider = "default" | "searxng" | "brave" | "serper" | "tavily"

export type WebSearchConfig = {
  provider: WebSearchProvider
  apiKey?: string
}

export function readWebSearchConfig(): WebSearchConfig {
  const raw = readConfigWing(MONOLITO_ROOT, "CONF_WEBSEARCH") as Partial<WebSearchConfig>
  const provider = raw.provider
  if (provider === "default" || provider === "searxng" || provider === "brave" || provider === "serper" || provider === "tavily") {
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
