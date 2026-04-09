import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const WEBSEARCH_FILE = join(homedir(), ".monolito-v2", "websearch.json")

export type WebSearchProvider = "default" | "curl" | "searxng"

export type WebSearchConfig = {
  provider: WebSearchProvider
}

export function readWebSearchConfig(): WebSearchConfig {
  try {
    const raw = JSON.parse(readFileSync(WEBSEARCH_FILE, "utf8")) as Partial<WebSearchConfig>
    const provider = raw.provider
    if (provider === "default" || provider === "curl" || provider === "searxng") {
      return { provider }
    }
  } catch {}
  return { provider: "default" }
}

export function writeWebSearchConfig(config: WebSearchConfig) {
  mkdirSync(join(homedir(), ".monolito-v2"), { recursive: true })
  writeFileSync(WEBSEARCH_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}
