import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { MONOLITO_ROOT } from "../system/root.ts"

const execFileAsync = promisify(execFile)

export const SEARXNG_CONTAINER = "monolito-searxng"
export const SEARXNG_PORT = 8888
export const SEARXNG_URL = `http://127.0.0.1:${SEARXNG_PORT}`
export const SEARXNG_SETTINGS_DIR = join(MONOLITO_ROOT, "searxng")
export const SEARXNG_SETTINGS_FILE = join(SEARXNG_SETTINGS_DIR, "settings.yml")

export type SearxngContainerInfo = {
  id: string
  name: string
  image: string
  status: string
  ports: string
  isOurs: boolean
}

export async function findAllSearxngContainers(): Promise<SearxngContainerInfo[]> {
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
    const containers: SearxngContainerInfo[] = []
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

export async function getOurContainerStatus(): Promise<"running" | "stopped" | "not_found" | "docker_error"> {
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

export async function isPortInUse(): Promise<{ inUse: boolean; detail?: string }> {
  try {
    const { stdout } = await execFileAsync("ss", ["-tlnp", `sport = :${SEARXNG_PORT}`], { timeout: 5_000 })
    const lines = stdout.trim().split("\n").filter(line => line.includes(`:${SEARXNG_PORT}`))
    if (lines.length > 0) return { inUse: true, detail: lines[0] }
  } catch {}
  return { inUse: false }
}

export async function removeContainer(idOrName: string): Promise<{ ok: boolean; message: string }> {
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

export async function removeAllSearxngContainers(): Promise<{ ok: boolean; message: string; count: number }> {
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

export function withManagedSearxngSettings(content: string) {
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

export async function ensureSearxngSettingsFile(): Promise<{ ok: boolean; message?: string }> {
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

export async function probeSearxngJsonApi() {
  try {
    const response = await fetch(`${SEARXNG_URL}/search?q=mountains&categories=images&format=json`, {
      signal: AbortSignal.timeout(5000),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function deploySearxng(): Promise<{ ok: boolean; message: string }> {
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

export async function stopSearxng(): Promise<{ ok: boolean; message: string }> {
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
