import { appendActionLog, readConfigWing, writeConfigWing } from "../session/store.ts"

export type WebSearchProvider = "default" | "searxng"

export type WebSearchConfig = {
  provider: WebSearchProvider
}

export function readWebSearchConfig(): WebSearchConfig {
  const raw = readConfigWing(process.cwd(), "CONF_WEBSEARCH") as Partial<WebSearchConfig>
  const provider = raw.provider
  if (provider === "default" || provider === "searxng") {
    return { provider }
  }
  return { provider: "default" }
}

export function writeWebSearchConfig(config: WebSearchConfig) {
  writeConfigWing(process.cwd(), "CONF_WEBSEARCH", config)
  appendActionLog(process.cwd(), "Configuracion de websearch actualizada", {
    wing: "CONF_WEBSEARCH",
    provider: config.provider,
  })
}
