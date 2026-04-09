/**
 * Interactive web search configuration menu.
 *
 * /websearch opens a selector for the web search strategy used by the agent.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readWebSearchConfig, writeWebSearchConfig, type WebSearchProvider } from "../../../core/websearch/config.ts"
import type { MenuState } from "./types.ts"

const execFileAsync = promisify(execFile)

const SEARXNG_CONTAINER = "monolito-searxng"
const SEARXNG_PORT = 8888
const SEARXNG_URL = `http://127.0.0.1:${SEARXNG_PORT}`

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

async function deploySearxng(): Promise<{ ok: boolean; message: string }> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 })
  } catch {
    return { ok: false, message: "Docker no está disponible o no está corriendo." }
  }

  const ourStatus = await getOurContainerStatus()
  if (ourStatus === "running") {
    try {
      const probe = await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(3000) })
      if (probe.ok) return { ok: true, message: "SearxNG ya está corriendo y responde." }
    } catch {}
    try {
      await execFileAsync("docker", ["restart", SEARXNG_CONTAINER], { timeout: 30_000 })
    } catch {}
  }

  const allContainers = await findAllSearxngContainers()
  const foreignContainers = allContainers.filter(container => !container.isOurs)
  const conflictMessages: string[] = []

  if (foreignContainers.length > 0) {
    conflictMessages.push(`Encontrados ${foreignContainers.length} contenedores SearxNG previos:`)
    for (const container of foreignContainers) {
      const result = await removeContainer(container.id)
      conflictMessages.push(`  ${container.name} (${container.image}, ${container.status}): ${result.ok ? "eliminado" : result.message}`)
    }
  }

  const portCheck = await isPortInUse()
  if (portCheck.inUse) {
    return {
      ok: false,
      message: [
        ...conflictMessages,
        `Puerto ${SEARXNG_PORT} ya está en uso por otro proceso:`,
        portCheck.detail ?? "(desconocido)",
        "Liberar el puerto o cambiar SEARXNG_PORT.",
      ].join("\n"),
    }
  }

  if (ourStatus === "stopped") {
    await removeContainer(SEARXNG_CONTAINER)
  }

  try {
    await execFileAsync("docker", [
      "run", "-d",
      "--name", SEARXNG_CONTAINER,
      "-p", `127.0.0.1:${SEARXNG_PORT}:8080`,
      "--restart", "unless-stopped",
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
      if (probe.ok) {
        return {
          ok: true,
          message: [
            ...conflictMessages,
            `SearxNG desplegado en ${SEARXNG_URL}`,
            `Container: ${SEARXNG_CONTAINER}`,
            `Puerto: 127.0.0.1:${SEARXNG_PORT} (solo localhost)`,
          ].join("\n"),
        }
      }
    } catch {}
  }

  return { ok: false, message: [...conflictMessages, "SearxNG se inició pero no responde después de 25s."].join("\n") }
}

async function stopSearxng(): Promise<{ ok: boolean; message: string }> {
  const status = await getOurContainerStatus()
  if (status === "not_found" || status === "docker_error") {
    return { ok: true, message: "SearxNG no está desplegado." }
  }
  try {
    await execFileAsync("docker", ["stop", SEARXNG_CONTAINER], { timeout: 15_000 })
    return { ok: true, message: "SearxNG detenido." }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Error deteniendo SearxNG: ${msg}` }
  }
}

function providerLabel(provider: WebSearchProvider) {
  switch (provider) {
    case "default":
      return "Default"
    case "curl":
      return "Curl / WebFetch"
    case "searxng":
      return "SearxNG local"
  }
}

async function renderProviderMenu(): Promise<string> {
  const config = readWebSearchConfig()
  const searxStatus = await getOurContainerStatus()
  const searxStatusLabel =
    searxStatus === "running" ? "corriendo" :
    searxStatus === "stopped" ? "detenido" :
    searxStatus === "not_found" ? "no desplegado" :
    "docker no disponible"

  return [
    "Web Search",
    "----------",
    `Metodo activo: ${providerLabel(config.provider)}`,
    "",
    "Elegi el comportamiento para busquedas web generales:",
    "1. Default",
    "2. Curl / WebFetch",
    `3. SearxNG local (${searxStatusLabel})`,
    "0. Salir",
    "",
    "Si elegis SearxNG, despues se abre su submenu de configuracion.",
    "",
    "Ingresá el número:",
  ].join("\n")
}

async function renderSearxngMenu(): Promise<string> {
  const config = readWebSearchConfig()
  const ourStatus = await getOurContainerStatus()
  const allContainers = await findAllSearxngContainers()
  const foreignCount = allContainers.filter(container => !container.isOurs).length

  const statusLabel =
    ourStatus === "running" ? "Corriendo" :
    ourStatus === "stopped" ? "Detenido" :
    ourStatus === "not_found" ? "No desplegado" :
    "Docker no disponible"

  const lines = [
    "Web Search / SearxNG",
    "-------------------",
    `Metodo activo: ${providerLabel(config.provider)}`,
    `Container: ${SEARXNG_CONTAINER}`,
    `Estado: ${statusLabel}`,
    `URL: ${SEARXNG_URL}`,
    `Puerto: 127.0.0.1:${SEARXNG_PORT} (solo localhost)`,
  ]

  if (foreignCount > 0) {
    lines.push(`Otros contenedores SearxNG: ${foreignCount} encontrados`)
  }

  lines.push(
    "",
    "Opciones:",
    `1. ${ourStatus === "running" ? "Reiniciar" : "Desplegar"} SearxNG`,
    "2. Detener SearxNG",
    `3. Eliminar container (${SEARXNG_CONTAINER})`,
  )

  if (foreignCount > 0) {
    lines.push(`4. Limpiar TODOS los contenedores SearxNG (${allContainers.length} total)`)
    lines.push("5. Test de búsqueda")
  } else {
    lines.push("4. Test de búsqueda")
  }

  lines.push("9. Volver", "0. Salir", "", "Ingresá el número:")
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
  if (!state) return exitMenu("Menu cerrado.")
  const trimmed = input.trim()
  const normalized = trimmed.toLowerCase()

  if (state.step === "ws-main" && ["salir", "exit", "q", "0", "/websearch"].includes(normalized)) {
    return exitMenu("Menu cerrado.")
  }
  if (state.step === "ws-searxng-main" && ["salir", "exit", "q", "0", "/websearch"].includes(normalized)) {
    return exitMenu("Menu cerrado.")
  }

  switch (state.step) {
    case "ws-main":
      return handleProviderMenu(trimmed)
    case "ws-searxng-main":
      return handleSearxngMenu(trimmed)
    case "ws-test-query":
      return handleTestQuery(trimmed)
    default:
      return exitMenu("Estado desconocido. Menu cerrado.")
  }
}

async function handleProviderMenu(input: string): Promise<WebSearchMenuResult> {
  switch (input) {
    case "1":
      writeWebSearchConfig({ provider: "default" })
      return openWebSearchMenu("✅ Metodo activo cambiado a Default.", "success")
    case "2":
      writeWebSearchConfig({ provider: "curl" })
      return openWebSearchMenu("✅ Metodo activo cambiado a Curl / WebFetch.", "success")
    case "3":
      writeWebSearchConfig({ provider: "searxng" })
      return openSearxngMenu("✅ Metodo activo cambiado a SearxNG local.", "success")
    default:
      return openWebSearchMenu(`❌ Opción "${input}" no válida.`, "error")
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
      return openSearxngMenu(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`, result.ok ? "success" : "error")
    }
    case "2": {
      const result = await stopSearxng()
      return openSearxngMenu(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`, result.ok ? "success" : "error")
    }
    case "3": {
      const result = await removeContainer(SEARXNG_CONTAINER)
      return openSearxngMenu(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`, result.ok ? "success" : "error")
    }
    case "9":
      return openWebSearchMenu()
    default: {
      if (input === cleanAllOption) {
        const result = await removeAllSearxngContainers()
        return openSearxngMenu(
          result.ok ? `✅ ${result.count} contenedores eliminados:\n${result.message}` : `❌ ${result.message}`,
          result.ok ? "success" : "error",
        )
      }
      if (input === testOption) {
        return {
          output: "Ingresá un término de búsqueda para probar (o 'cancel' para volver):",
          nextState: { step: "ws-test-query", draft: { provider: "searxng" } },
          tone: "info",
        }
      }
      return openSearxngMenu(`❌ Opción "${input}" no válida.`, "error")
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
      return openSearxngMenu(`❌ SearxNG respondió HTTP ${response.status}. ¿Está corriendo?`, "error")
    }
    const data = await response.json() as { results?: Array<{ title?: string; url?: string }> }
    const results = (data.results ?? []).slice(0, 5)
    if (results.length === 0) {
      return openSearxngMenu(`Búsqueda "${input}" — 0 resultados.`, "info")
    }
    const lines = results.map((result, index) => `  ${index + 1}. ${result.title ?? "(sin título)"}\n     ${result.url ?? ""}`).join("\n")
    return openSearxngMenu(`Búsqueda "${input}" — ${results.length} resultados:\n\n${lines}`, "success")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return openSearxngMenu(`❌ Error: ${msg}. ¿SearxNG está corriendo?`, "error")
  }
}

function exitMenu(message: string): WebSearchMenuResult {
  return { output: message, nextState: null, tone: "neutral" }
}
