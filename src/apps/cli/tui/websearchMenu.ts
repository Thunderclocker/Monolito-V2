/**
 * Interactive web search configuration menu.
 *
 * /websearch opens a selector for the web search strategy used by the
 * agent. The previous local SearXNG managed-container flow was removed;
 * the menu now only lets the user pick a hosted API provider (or "default"
 * which means "no provider configured — search will fail with a clear
 * error"). API key entry is handled by the standard /config set flow.
 */
import { readWebSearchConfig, writeWebSearchConfig, type WebSearchProvider } from "../../../core/websearch/config.ts"
import type { MenuState } from "./types.ts"

export type WebSearchMenuResult = {
  output: string
  nextState: MenuState
  tone: "neutral" | "info" | "success" | "error"
}

function providerLabel(provider: WebSearchProvider) {
  switch (provider) {
    case "default":
      return "Default (no provider)"
    case "brave":
      return "Brave Search API"
    case "serper":
      return "Serper (Google)"
    case "tavily":
      return "Tavily"
  }
}

async function renderProviderMenu(): Promise<string> {
  const config = readWebSearchConfig()
  const hasKey = typeof config.apiKey === "string" && config.apiKey.length > 0
  const keyNote = hasKey ? "apiKey: configured" : "apiKey: NOT set (search will fail)"

  return [
    "Web Search",
    "----------",
    `Active provider: ${providerLabel(config.provider)} (${keyNote})`,
    "",
    "Choose the hosted API provider for general web search:",
    "1. Default (no provider — disables web search)",
    "2. Brave Search API  (set CONF_WEBSEARCH.apiKey to your Brave key)",
    "3. Serper (Google)   (set CONF_WEBSEARCH.apiKey to your Serper key)",
    "4. Tavily            (set CONF_WEBSEARCH.apiKey to your Tavily key)",
    "0. Exit",
    "",
    "Note: API keys are configured separately via /config set websearch_api_key <key>",
    "or via the tool_manage_config action='set' for CONF_WEBSEARCH.apiKey.",
    "",
    "Enter number:",
  ].join("\n")
}

export async function openWebSearchMenu(prefixMessage?: string, tone: WebSearchMenuResult["tone"] = "info"): Promise<WebSearchMenuResult> {
  const menu = await renderProviderMenu()
  return {
    output: prefixMessage ? `${prefixMessage}\n\n${menu}` : menu,
    nextState: { step: "ws-main", draft: {} },
    tone,
  }
}

export async function processWebSearchMenuInput(input: string, state: MenuState): Promise<WebSearchMenuResult> {
  if (!state) return exitMenu("Menu closed.")
  const trimmed = input.trim()
  const normalized = trimmed.toLowerCase()

  if (state.step === "ws-main" && ["salir", "exit", "q", "0", "/websearch"].includes(normalized)) {
    return exitMenu("Menu closed.")
  }

  switch (state.step) {
    case "ws-main":
      return handleProviderMenu(trimmed)
    default:
      return exitMenu("Unknown state. Menu closed.")
  }
}

async function handleProviderMenu(input: string): Promise<WebSearchMenuResult> {
  switch (input) {
    case "1":
      writeWebSearchConfig({ provider: "default" })
      return openWebSearchMenu("Provider set to Default (no web search).", "success")
    case "2":
      writeWebSearchConfig({ provider: "brave" })
      return openWebSearchMenu("Provider set to Brave. Remember to set the API key via /config set websearch_api_key.", "success")
    case "3":
      writeWebSearchConfig({ provider: "serper" })
      return openWebSearchMenu("Provider set to Serper. Remember to set the API key via /config set websearch_api_key.", "success")
    case "4":
      writeWebSearchConfig({ provider: "tavily" })
      return openWebSearchMenu("Provider set to Tavily. Remember to set the API key via /config set websearch_api_key.", "success")
    default:
      return openWebSearchMenu(`Invalid option "${input}".`, "error")
  }
}

function exitMenu(message: string): WebSearchMenuResult {
  return { output: message, nextState: null, tone: "neutral" }
}
