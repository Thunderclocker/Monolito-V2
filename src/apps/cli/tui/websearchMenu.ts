/**
 * Interactive web search configuration menu.
 *
 * /websearch opens a selector for the web search strategy used by the agent.
 */
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { readWebSearchConfig, writeWebSearchConfig, type WebSearchProvider } from "../../../core/websearch/config.ts"
import { MONOLITO_ROOT } from "../../../core/system/root.ts"
import type { MenuState } from "./types.ts"

const execFileAsync = promisify(execFile)

const SEARXNG_CONTAINER = "monolito-searxng"
const SEARXNG_PORT = 8888
const SEARXNG_URL = `http://127.0.0.1:${SEARXNG_PORT}`
const SEARXNG_SETTINGS_DIR = join(MONOLITO_ROOT, "searxng")
const SEARXNG_SETTINGS_FILE = join(SEARXNG_SETTINGS_DIR, "settings.yml")

export type WebSearchMenuResult = {
  output: string
  nextState: MenuState
  tone: "neutral" | "info" | "success" | "error"
}

type ContainerInfo = {
  id: string
  name: string
  image: string
  status: string
  ports: string
  isOurs: boolean
}

async function findAllSearxngContainers(): Promise<ContainerInfo[]> {
  try {
    const { stdout: byImage } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", "ancestor=searxng/searxng",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}",
    ], { timeout: 10_000 })
    const { stdout: byName } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", "name=searxng",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}",
    ], { timeout: 10_000 })

    const seen = new Set<string>()
    const containers: ContainerInfo[] = []
    for (const line of [...byImage.trim().split("\n"), ...byName.trim().split("\n")]) {
      if (!line.trim()) continue
      const [id, name, image, status, ports] = line.split("\t")
      if (!id || seen.has(id)) continue
      seen.add(id)
      containers.push({
        id: id.slice(0, 12),
        name: name ?? "",
        image: image ?? "",
        status: status ?? "",
        ports: ports ?? "",
        isOurs: name === SEARXNG_CONTAINER,
      })
    }
    return containers
  } catch {
    return []
  }
}

async function getOurContainerStatus(): Promise<"running" | "stopped" | "not_found" | "docker_error"> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", `name=^/${SEARXNG_CONTAINER}$`,
      "--format", "{{.Status}}",
    ], { timeout: 10_000 })
    const status = stdout.trim()
    if (!status) return "not_found"
    return status.startsWith("Up") ? "running" : "stopped"
  } catch {
    return "docker_error"
  }
}

async function isPortInUse(): Promise<{ inUse: boolean; detail?: string }> {
  try {
    const { stdout } = await execFileAsync("ss", ["-tlnp", `sport = :${SEARXNG_PORT}`], { timeout: 5_000 })
    const lines = stdout.trim().split("\n").filter(line => line.includes(`:${SEARXNG_PORT}`))
    if (lines.length > 0) return { inUse: true, detail: lines[0] }
  } catch {}
  return { inUse: false }
}

async function removeContainer(idOrName: string): Promise<{ ok: boolean; message: string }> {
  if (idOrName === SEARXNG_CONTAINER) {
    const containers = await findAllSearxngContainers()
    const ours = containers.find(container => container.isOurs)
    if (!ours) {
      return { ok: true, message: "SearxNG is not deployed." }
    }
    idOrName = ours.id
  }
  try {
    await execFileAsync("docker", ["rm", "-f", idOrName], { timeout: 15_000 })
    return { ok: true, message: `Contenedor ${idOrName} eliminado.` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Error eliminando ${idOrName}: ${msg}` }
  }
}

async function removeAllSearxngContainers(): Promise<{ ok: boolean; message: string; count: number }> {
  const containers = await findAllSearxngContainers()
  if (containers.length === 0) {
    return { ok: true, message: "No se encontraron contenedores SearxNG.", count: 0 }
  }
  const results: string[] = []
  let allOk = true
  for (const container of containers) {
    const result = await removeContainer(container.id)
    results.push(`${container.name} (${container.id}): ${result.ok ? "eliminado" : result.message}`)
    if (!result.ok) allOk = false
  }
  return { ok: allOk, message: results.join("\n"), count: containers.length }
}

function withManagedSearxngSettings(content: string) {
  let updated = content
  if (!/^\s*-\s*json\s*$/m.test(updated)) {
    updated = updated.replace(/(^\s*formats:\n(?:\s*#.*\n)*\s*-\s*html\s*$)/m, `$1\n    - json`)
  }
  if (/^\s*safe_search:\s*0\s*$/m.test(updated)) return updated
  if (/^\s*safe_search:\s*\d+\s*$/m.test(updated)) {
    return updated.replace(/^(\s*safe_search:\s*)\d+\s*$/m, (_, prefix: string) => `${prefix}0`)
  }
  if (/^\s*search:\s*$/m.test(updated)) {
    return updated.replace(/^(\s*search:\s*)$/m, "$1\n  safe_search: 0")
  }
  return updated
}

async function ensureSearxngSettingsFile(): Promise<{ ok: boolean; message?: string }> {
  mkdirSync(SEARXNG_SETTINGS_DIR, { recursive: true })
  if (existsSync(SEARXNG_SETTINGS_FILE)) {
    const current = readFileSync(SEARXNG_SETTINGS_FILE, "utf8")
    const updated = withManagedSearxngSettings(current)
    if (updated !== current) writeFileSync(SEARXNG_SETTINGS_FILE, updated, "utf8")
    if (/^\s*-\s*json\s*$/m.test(updated) && /^\s*safe_search:\s*0\s*$/m.test(updated)) return { ok: true }
  }

  const bootstrapContainer = `${SEARXNG_CONTAINER}-bootstrap`
  let createdBootstrap = false
  try {
    const status = await getOurContainerStatus()
    if (status === "not_found") {
      await execFileAsync("docker", ["run", "-d", "--name", bootstrapContainer, "searxng/searxng:latest"], { timeout: 60_000 })
      createdBootstrap = true
      await new Promise(resolve => setTimeout(resolve, 3000))
      await execFileAsync("docker", ["cp", `${bootstrapContainer}:/etc/searxng/settings.yml`, SEARXNG_SETTINGS_FILE], { timeout: 15_000 })
    } else {
      await execFileAsync("docker", ["cp", `${SEARXNG_CONTAINER}:/etc/searxng/settings.yml`, SEARXNG_SETTINGS_FILE], { timeout: 15_000 })
    }
    const updated = withManagedSearxngSettings(readFileSync(SEARXNG_SETTINGS_FILE, "utf8"))
    writeFileSync(SEARXNG_SETTINGS_FILE, updated, "utf8")
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Could not prepare SearxNG settings.yml: ${msg}` }
  } finally {
    if (createdBootstrap) {
      await execFileAsync("docker", ["rm", "-f", bootstrapContainer], { timeout: 15_000 }).catch(() => {})
    }
  }
}

async function probeSearxngJsonApi() {
  try {
    const response = await fetch(`${SEARXNG_URL}/search?q=mountains&categories=images&format=json`, {
      signal: AbortSignal.timeout(5000),
    })
    return response.ok
  } catch {
    return false
  }
}

async function deploySearxng(): Promise<{ ok: boolean; message: string }> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 })
  } catch {
    return { ok: false, message: "Docker is unavailable or not running." }
  }

  const ourStatus = await getOurContainerStatus()
  if (ourStatus === "running") {
    try {
      const probe = await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(3000) })
      if (probe.ok && await probeSearxngJsonApi()) return { ok: true, message: "SearxNG is already running and responding." }
    } catch {}
  }

  const settings = await ensureSearxngSettingsFile()
  if (!settings.ok) {
    return { ok: false, message: settings.message ?? "Could not prepare the SearxNG configuration." }
  }

  const allContainers = await findAllSearxngContainers()
  const foreignContainers = allContainers.filter(container => !container.isOurs)
  const conflictMessages: string[] = []

  if (foreignContainers.length > 0) {
    conflictMessages.push(`Found ${foreignContainers.length} existing SearxNG containers:`)
    for (const container of foreignContainers) {
      const result = await removeContainer(container.id)
      conflictMessages.push(`  ${container.name} (${container.image}, ${container.status}): ${result.ok ? "removed" : result.message}`)
    }
  }

  const portCheck = await isPortInUse()
  if (portCheck.inUse) {
    return {
      ok: false,
      message: [
        ...conflictMessages,
        `Port ${SEARXNG_PORT} is already in use by another process:`,
        portCheck.detail ?? "(desconocido)",
        "Free the port or change SEARXNG_PORT.",
      ].join("\n"),
    }
  }

  if (ourStatus === "running" || ourStatus === "stopped") {
    await removeContainer(SEARXNG_CONTAINER)
  }

  try {
    await execFileAsync("docker", [
      "run", "-d",
      "--name", SEARXNG_CONTAINER,
      "-p", `127.0.0.1:${SEARXNG_PORT}:8080`,
      "--restart", "unless-stopped",
      "-v", `${SEARXNG_SETTINGS_FILE}:/etc/searxng/settings.yml:ro`,
      "searxng/searxng:latest",
    ], { timeout: 120_000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: [...conflictMessages, `Error desplegando: ${msg}`].join("\n") }
  }

  for (let i = 0; i < 25; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    try {
      const probe = await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(2000) })
      if (probe.ok && await probeSearxngJsonApi()) {
        return {
          ok: true,
          message: [
            ...conflictMessages,
            `SearxNG deployed at ${SEARXNG_URL}`,
            `Container: ${SEARXNG_CONTAINER}`,
            `Port: 127.0.0.1:${SEARXNG_PORT} (localhost only)`,
          ].join("\n"),
        }
      }
    } catch {}
  }

  return { ok: false, message: [...conflictMessages, "SearxNG started but its JSON API did not respond after 25s."].join("\n") }
}

async function stopSearxng(): Promise<{ ok: boolean; message: string }> {
  const status = await getOurContainerStatus()
  if (status === "not_found" || status === "docker_error") {
    return { ok: true, message: "SearxNG is not deployed." }
  }
  try {
    await execFileAsync("docker", ["stop", SEARXNG_CONTAINER], { timeout: 15_000 })
    return { ok: true, message: "SearxNG stopped." }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Error stopping SearxNG: ${msg}` }
  }
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
