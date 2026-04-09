/**
 * Interactive web search configuration menu.
 *
 * /websearch opens this menu to select and configure the search engine
 * used by the agent for web and image searches.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
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

// ---------------------------------------------------------------------------
// Container info type
// ---------------------------------------------------------------------------

type ContainerInfo = {
  id: string
  name: string
  image: string
  status: string
  ports: string
  isOurs: boolean // name matches SEARXNG_CONTAINER
}

// ---------------------------------------------------------------------------
// SearxNG Docker helpers
// ---------------------------------------------------------------------------

/** Find ALL SearxNG containers (by image name), not just ours */
async function findAllSearxngContainers(): Promise<ContainerInfo[]> {
  try {
    // Search by image (catches any searxng container regardless of name)
    const { stdout: byImage } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", "ancestor=searxng/searxng",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}",
    ], { timeout: 10_000 })

    // Also search by name pattern (catches renamed or rebuilt containers)
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

/** Get status of our specific container */
async function getOurContainerStatus(): Promise<"running" | "stopped" | "not_found" | "docker_error"> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps", "-a", "--filter", `name=^/${SEARXNG_CONTAINER}$`, "--format", "{{.Status}}",
    ], { timeout: 10_000 })
    const status = stdout.trim()
    if (!status) return "not_found"
    return status.startsWith("Up") ? "running" : "stopped"
  } catch {
    return "docker_error"
  }
}

/** Check if port is already in use */
async function isPortInUse(): Promise<{ inUse: boolean; detail?: string }> {
  try {
    const { stdout } = await execFileAsync("ss", ["-tlnp", `sport = :${SEARXNG_PORT}`], { timeout: 5_000 })
    const lines = stdout.trim().split("\n").filter(l => l.includes(`:${SEARXNG_PORT}`))
    if (lines.length > 0) return { inUse: true, detail: lines[0] }
    return { inUse: false }
  } catch {
    return { inUse: false }
  }
}

/** Remove a container by ID or name */
async function removeContainer(idOrName: string): Promise<{ ok: boolean; message: string }> {
  try {
    await execFileAsync("docker", ["rm", "-f", idOrName], { timeout: 15_000 })
    return { ok: true, message: `Contenedor ${idOrName} eliminado.` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Error eliminando ${idOrName}: ${msg}` }
  }
}

/** Remove ALL SearxNG containers found */
async function removeAllSearxngContainers(): Promise<{ ok: boolean; message: string; count: number }> {
  const containers = await findAllSearxngContainers()
  if (containers.length === 0) {
    return { ok: true, message: "No se encontraron contenedores SearxNG.", count: 0 }
  }
  const results: string[] = []
  let allOk = true
  for (const c of containers) {
    const r = await removeContainer(c.id)
    results.push(`${c.name} (${c.id}): ${r.ok ? "eliminado" : r.message}`)
    if (!r.ok) allOk = false
  }
  return {
    ok: allOk,
    message: results.join("\n"),
    count: containers.length,
  }
}

/** Deploy our SearxNG container, cleaning up conflicts first */
async function deploySearxng(): Promise<{ ok: boolean; message: string }> {
  // Check Docker availability
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 })
  } catch {
    return { ok: false, message: "Docker no está disponible o no está corriendo." }
  }

  const ourStatus = await getOurContainerStatus()

  // If ours is running, just verify it responds
  if (ourStatus === "running") {
    try {
      const probe = await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(3000) })
      if (probe.ok) return { ok: true, message: "SearxNG ya está corriendo y responde." }
    } catch {}
    // Running but not responding — restart it
    try {
      await execFileAsync("docker", ["restart", SEARXNG_CONTAINER], { timeout: 30_000 })
    } catch {}
  }

  // Check for OTHER searxng containers that might conflict
  const allContainers = await findAllSearxngContainers()
  const foreignContainers = allContainers.filter(c => !c.isOurs)
  const conflictMessages: string[] = []

  if (foreignContainers.length > 0) {
    conflictMessages.push(`Encontrados ${foreignContainers.length} contenedores SearxNG previos:`)
    for (const c of foreignContainers) {
      const r = await removeContainer(c.id)
      conflictMessages.push(`  ${c.name} (${c.image}, ${c.status}): ${r.ok ? "eliminado" : r.message}`)
    }
  }

  // Check port conflict from non-Docker processes
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

  // Remove our stopped container if exists (clean re-deploy)
  if (ourStatus === "stopped") {
    await removeContainer(SEARXNG_CONTAINER)
  }

  // Deploy fresh
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
    return {
      ok: false,
      message: [...conflictMessages, `Error desplegando: ${msg}`].join("\n"),
    }
  }

  // Wait for healthy
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 1000))
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

  return {
    ok: false,
    message: [...conflictMessages, "SearxNG se inició pero no responde después de 25s."].join("\n"),
  }
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

// ---------------------------------------------------------------------------
// Menu rendering
// ---------------------------------------------------------------------------

async function renderMainMenu(): Promise<string> {
  const ourStatus = await getOurContainerStatus()
  const allContainers = await findAllSearxngContainers()
  const foreignCount = allContainers.filter(c => !c.isOurs).length

  const statusLabel =
    ourStatus === "running" ? "Corriendo" :
    ourStatus === "stopped" ? "Detenido" :
    ourStatus === "not_found" ? "No desplegado" :
    "Docker no disponible"

  const lines = [
    `Web Search Configuration`,
    `------------------------`,
    `Motor: SearxNG (Docker local)`,
    `Container: ${SEARXNG_CONTAINER}`,
    `Estado: ${statusLabel}`,
    `URL: ${SEARXNG_URL}`,
    `Puerto: 127.0.0.1:${SEARXNG_PORT} (solo localhost)`,
  ]

  if (foreignCount > 0) {
    lines.push(`Otros contenedores SearxNG: ${foreignCount} encontrados`)
  }

  lines.push(
    ``,
    `Opciones:`,
    `1. ${ourStatus === "running" ? "Reiniciar" : "Desplegar"} SearxNG`,
    `2. Detener SearxNG`,
    `3. Eliminar container (${SEARXNG_CONTAINER})`,
  )

  if (foreignCount > 0) {
    lines.push(`4. Limpiar TODOS los contenedores SearxNG (${allContainers.length} total)`)
    lines.push(`5. Test de búsqueda`)
  } else {
    lines.push(`4. Test de búsqueda`)
  }

  lines.push(`0. Salir`, ``, `Ingresá el número:`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function openWebSearchMenu(prefixMessage?: string, tone: WebSearchMenuResult["tone"] = "info"): Promise<WebSearchMenuResult> {
  const menu = await renderMainMenu()
  return {
    output: prefixMessage ? `${prefixMessage}\n\n${menu}` : menu,
    nextState: { step: "ws-main", draft: {} },
    tone,
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function processWebSearchMenuInput(input: string, state: MenuState): Promise<WebSearchMenuResult> {
  if (!state) return exitMenu("Menu cerrado.")
  const trimmed = input.trim()

  if (["salir", "exit", "q", "0", "/websearch"].includes(trimmed.toLowerCase()) && state.step === "ws-main") {
    return exitMenu("Menu cerrado.")
  }

  switch (state.step) {
    case "ws-main":
      return handleMainMenu(trimmed)
    case "ws-test-query":
      return handleTestQuery(trimmed)
    default:
      return exitMenu("Estado desconocido. Menu cerrado.")
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleMainMenu(input: string): Promise<WebSearchMenuResult> {
  const allContainers = await findAllSearxngContainers()
  const foreignCount = allContainers.filter(c => !c.isOurs).length
  // Dynamic option mapping: if foreign containers exist, option 4 = clean all, 5 = test
  // Otherwise, option 4 = test
  const testOption = foreignCount > 0 ? "5" : "4"
  const cleanAllOption = foreignCount > 0 ? "4" : null

  switch (input) {
    case "1": {
      const result = await deploySearxng()
      return openWebSearchMenu(
        result.ok ? `✅ ${result.message}` : `❌ ${result.message}`,
        result.ok ? "success" : "error",
      )
    }
    case "2": {
      const result = await stopSearxng()
      return openWebSearchMenu(
        result.ok ? `✅ ${result.message}` : `❌ ${result.message}`,
        result.ok ? "success" : "error",
      )
    }
    case "3": {
      const result = await removeContainer(SEARXNG_CONTAINER)
      return openWebSearchMenu(
        result.ok ? `✅ ${result.message}` : `❌ ${result.message}`,
        result.ok ? "success" : "error",
      )
    }
    default: {
      if (input === cleanAllOption) {
        const result = await removeAllSearxngContainers()
        return openWebSearchMenu(
          result.ok
            ? `✅ ${result.count} contenedores eliminados:\n${result.message}`
            : `❌ ${result.message}`,
          result.ok ? "success" : "error",
        )
      }
      if (input === testOption) {
        return {
          output: "Ingresá un término de búsqueda para probar (o 'cancel' para volver):",
          nextState: { step: "ws-test-query" as any, draft: {} },
          tone: "info",
        }
      }
      return openWebSearchMenu(`❌ Opción "${input}" no válida.`, "error")
    }
  }
}

async function handleTestQuery(input: string): Promise<WebSearchMenuResult> {
  if (["cancel", "cancelar", "0"].includes(input.toLowerCase())) {
    return openWebSearchMenu()
  }

  const query = encodeURIComponent(input.trim())
  try {
    const res = await fetch(`${SEARXNG_URL}/search?q=${query}&format=json`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      return openWebSearchMenu(`❌ SearxNG respondió HTTP ${res.status}. ¿Está corriendo?`, "error")
    }
    const data = await res.json() as { results?: Array<{ title?: string; url?: string }> }
    const results = (data.results ?? []).slice(0, 5)
    if (results.length === 0) {
      return openWebSearchMenu(`Búsqueda "${input}" — 0 resultados.`, "info")
    }
    const lines = results.map((r, i) => `  ${i + 1}. ${r.title ?? "(sin título)"}\n     ${r.url ?? ""}`).join("\n")
    return openWebSearchMenu(`Búsqueda "${input}" — ${results.length} resultados:\n\n${lines}`, "success")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return openWebSearchMenu(`❌ Error: ${msg}. ¿SearxNG está corriendo?`, "error")
  }
}

function exitMenu(message: string): WebSearchMenuResult {
  return { output: message, nextState: null, tone: "neutral" }
}
