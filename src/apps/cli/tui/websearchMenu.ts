/**
 * Interactive web search configuration menu.
 *
 * /websearch opens a selector for the web search strategy used by the agent.
 */
import { readWebSearchConfig, writeWebSearchConfig, type WebSearchProvider } from "../../../core/websearch/config.ts"
import {
  deploySearxng,
  findAllSearxngContainers,
  getOurContainerStatus,
  removeAllSearxngContainers,
  removeContainer,
  SEARXNG_CONTAINER,
  SEARXNG_PORT,
  SEARXNG_URL,
  stopSearxng,
} from "../../../core/websearch/managed.ts"
import type { MenuState } from "./types.ts"

export type WebSearchMenuResult = {
  output: string
  nextState: MenuState
  tone: "neutral" | "info" | "success" | "error"
}

function providerLabel(provider: WebSearchProvider) {
  switch (provider) {
    case "default":
      return "Default"
    case "searxng":
      return "SearxNG local"
  }
}

async function renderProviderMenu(): Promise<string> {
  const config = readWebSearchConfig()
  const searxStatus = await getOurContainerStatus()
  const searxStatusLabel =
    searxStatus === "running" ? "running" :
    searxStatus === "stopped" ? "stopped" :
    searxStatus === "not_found" ? "not deployed" :
    "docker unavailable"

  return [
    "Web Search",
    "----------",
    `Active mode: ${providerLabel(config.provider)}`,
    "",
    "Choose the behavior for general web search:",
    "1. Default",
    `2. SearxNG local (${searxStatusLabel})`,
    "0. Exit",
    "",
    "If you choose SearxNG, it is deployed/started automatically and its submenu opens next.",
    "",
    "Enter number:",
  ].join("\n")
}

async function renderSearxngMenu(): Promise<string> {
  const config = readWebSearchConfig()
  const ourStatus = await getOurContainerStatus()
  const allContainers = await findAllSearxngContainers()
  const foreignCount = allContainers.filter(container => !container.isOurs).length

  const statusLabel =
    ourStatus === "running" ? "Running" :
    ourStatus === "stopped" ? "Stopped" :
    ourStatus === "not_found" ? "Not deployed" :
    "Docker unavailable"

  const lines = [
    "Web Search / SearxNG",
    "-------------------",
    `Active mode: ${providerLabel(config.provider)}`,
    `Container: ${SEARXNG_CONTAINER}`,
    `Status: ${statusLabel}`,
    `URL: ${SEARXNG_URL}`,
    `Port: 127.0.0.1:${SEARXNG_PORT} (localhost only)`,
  ]

  if (foreignCount > 0) {
    lines.push(`Other SearxNG containers: ${foreignCount} found`)
  }

  const knownContainers = allContainers.length > 0
    ? allContainers.map(container => `- ${container.name || "(unnamed)"} | ${container.id} | ${container.status}`).join("\n")
    : "- none"

  lines.push(
    "",
    "Detected containers:",
    knownContainers,
    "",
    "Options:",
    `1. ${ourStatus === "running" ? "Restart" : "Start"} SearxNG`,
    "2. Stop SearxNG",
    `3. Remove container (${SEARXNG_CONTAINER})`,
  )

  if (foreignCount > 0) {
    lines.push(`4. Clean ALL SearxNG containers (${allContainers.length} total)`)
    lines.push("5. Test search")
  } else {
    lines.push("4. Test search")
  }

  lines.push("9. Back", "0. Exit", "", "Enter number:")
  return lines.join("\n")
}

export async function openWebSearchMenu(prefixMessage?: string, tone: WebSearchMenuResult["tone"] = "info"): Promise<WebSearchMenuResult> {
  const menu = await renderProviderMenu()
  return {
    output: prefixMessage ? `${prefixMessage}\n\n${menu}` : menu,
    nextState: { step: "ws-main", draft: {} },
    tone,
  }
}

async function openSearxngMenu(prefixMessage?: string, tone: WebSearchMenuResult["tone"] = "info"): Promise<WebSearchMenuResult> {
  const menu = await renderSearxngMenu()
  return {
    output: prefixMessage ? `${prefixMessage}\n\n${menu}` : menu,
    nextState: { step: "ws-searxng-main", draft: {} },
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
  if (state.step === "ws-searxng-main" && ["salir", "exit", "q", "0", "/websearch"].includes(normalized)) {
    return exitMenu("Menu closed.")
  }

  switch (state.step) {
    case "ws-main":
      return handleProviderMenu(trimmed)
    case "ws-searxng-main":
      return handleSearxngMenu(trimmed)
    case "ws-test-query":
      return handleTestQuery(trimmed)
    default:
      return exitMenu("Unknown state. Menu closed.")
  }
}

async function handleProviderMenu(input: string): Promise<WebSearchMenuResult> {
  switch (input) {
    case "1":
      writeWebSearchConfig({ provider: "default" })
      return openWebSearchMenu("Mode set to Default.", "success")
    case "2":
      writeWebSearchConfig({ provider: "searxng" })
      {
        const result = await deploySearxng()
        return openSearxngMenu(
          result.ok
            ? `Mode set to local SearxNG.\n${result.message}`
            : `Mode set to local SearxNG.\n${result.message}`,
          result.ok ? "success" : "error",
        )
      }
    default:
      return openWebSearchMenu(`Invalid option "${input}".`, "error")
  }
}

async function handleSearxngMenu(input: string): Promise<WebSearchMenuResult> {
  const allContainers = await findAllSearxngContainers()
  const foreignCount = allContainers.filter(container => !container.isOurs).length
  const testOption = foreignCount > 0 ? "5" : "4"
  const cleanAllOption = foreignCount > 0 ? "4" : null

  switch (input) {
    case "1": {
      const result = await deploySearxng()
      return openSearxngMenu(result.message, result.ok ? "success" : "error")
    }
    case "2": {
      const result = await stopSearxng()
      return openSearxngMenu(result.message, result.ok ? "success" : "error")
    }
    case "3": {
      const result = await removeContainer(SEARXNG_CONTAINER)
      return openSearxngMenu(result.message, result.ok ? "success" : "error")
    }
    case "9":
      return openWebSearchMenu()
    default: {
      if (input === cleanAllOption) {
        const result = await removeAllSearxngContainers()
        return openSearxngMenu(
          result.ok ? `${result.count} containers removed:\n${result.message}` : result.message,
          result.ok ? "success" : "error",
        )
      }
      if (input === testOption) {
        return {
          output: "Enter a search term to test (or 'cancel' to go back):",
          nextState: { step: "ws-test-query", draft: { provider: "searxng" } },
          tone: "info",
        }
      }
      return openSearxngMenu(`Invalid option "${input}".`, "error")
    }
  }
}

async function handleTestQuery(input: string): Promise<WebSearchMenuResult> {
  if (["cancel", "cancelar", "0"].includes(input.toLowerCase())) {
    return openSearxngMenu()
  }

  const query = encodeURIComponent(input.trim())
  try {
    const response = await fetch(`${SEARXNG_URL}/search?q=${query}&format=json`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return openSearxngMenu(`SearxNG returned HTTP ${response.status}. Is it running?`, "error")
    }
    const data = await response.json() as { results?: Array<{ title?: string; url?: string }> }
    const results = (data.results ?? []).slice(0, 5)
    if (results.length === 0) {
      return openSearxngMenu(`Search "${input}" — 0 results.`, "info")
    }
    const lines = results.map((result, index) => `  ${index + 1}. ${result.title ?? "(untitled)"}\n     ${result.url ?? ""}`).join("\n")
    return openSearxngMenu(`Search "${input}" — ${results.length} results:\n\n${lines}`, "success")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return openSearxngMenu(`Error: ${msg}. Is SearxNG running?`, "error")
  }
}

function exitMenu(message: string): WebSearchMenuResult {
  return { output: message, nextState: null, tone: "neutral" }
}
