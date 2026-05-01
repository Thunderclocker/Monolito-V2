import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import type { VisionConfig } from "../channels/config.ts"
import { MONOLITO_ROOT } from "../system/root.ts"

const execFileAsync = promisify(execFile)

export type ManagedVisionStatus = "running" | "stopped" | "not_found" | "docker_error"

export type ManagedVisionContainerInfo = {
  id: string
  name: string
  image: string
  status: string
  ports: string
  restartPolicy?: string
  hasModelVolume?: boolean
  isOurs: boolean
}

export function normalizeVisionConfig(config?: Partial<VisionConfig>): VisionConfig {
  const port = typeof config?.port === "number" && Number.isFinite(config.port) && config.port > 0 && config.port <= 65535
    ? Math.trunc(config.port)
    : 11435
  return {
    managed: typeof config?.managed === "boolean" ? config.managed : true,
    autoDeploy: typeof config?.autoDeploy === "boolean" ? config.autoDeploy : true,
    port,
    containerName: typeof config?.containerName === "string" && config.containerName.trim()
      ? config.containerName.trim()
      : "monolito-vision-moondream",
    model: typeof config?.model === "string" && config.model.trim() ? config.model.trim() : "moondream",
  }
}

export function getManagedVisionBaseUrl(config: VisionConfig) {
  return `http://127.0.0.1:${config.port}`
}

function getManagedVisionModelDir() {
  return join(MONOLITO_ROOT, "vision-ollama")
}

async function probeManagedVision(config: VisionConfig) {
  try {
    const response = await fetch(`${getManagedVisionBaseUrl(config)}/api/tags`, {
      signal: AbortSignal.timeout(4_000),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function getManagedVisionStatus(config: VisionConfig): Promise<ManagedVisionStatus> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", `name=^/${config.containerName}$`,
      "--format", "{{.Status}}",
    ], { timeout: 10_000 })
    const status = stdout.trim()
    if (!status) return "not_found"
    return status.startsWith("Up") ? "running" : "stopped"
  } catch {
    return "docker_error"
  }
}

async function inspectVisionContainer(name: string): Promise<{ restartPolicy: string | null; hasModelVolume: boolean }> {
  try {
    const { stdout: restartStdout } = await execFileAsync("docker", [
      "inspect",
      "--format", "{{.HostConfig.RestartPolicy.Name}}",
      name,
    ], { timeout: 10_000 })
    const { stdout: mountsStdout } = await execFileAsync("docker", [
      "inspect",
      "--format", "{{range .Mounts}}{{.Destination}}={{.Source}};{{end}}",
      name,
    ], { timeout: 10_000 })
    return {
      restartPolicy: restartStdout.trim() || null,
      hasModelVolume: mountsStdout.includes("/root/.ollama="),
    }
  } catch {
    return { restartPolicy: null, hasModelVolume: false }
  }
}

async function ensureRestartPolicy(name: string) {
  const info = await inspectVisionContainer(name)
  if (info.restartPolicy === "unless-stopped") return false
  await execFileAsync("docker", ["update", "--restart", "unless-stopped", name], { timeout: 15_000 })
  return true
}

export async function findManagedVisionContainers(config: VisionConfig): Promise<ManagedVisionContainerInfo[]> {
  try {
    const { stdout: byImage } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", "ancestor=ollama/ollama",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}",
    ], { timeout: 10_000 })
    const { stdout: byName } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", `name=${config.containerName}`,
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}",
    ], { timeout: 10_000 })

    const seen = new Set<string>()
    const containers: ManagedVisionContainerInfo[] = []
    for (const line of [...byImage.trim().split("\n"), ...byName.trim().split("\n")]) {
      if (!line.trim()) continue
      const [id, name, image, status, ports] = line.split("\t")
      if (!id || seen.has(id)) continue
      seen.add(id)
      const inspected = await inspectVisionContainer(name ?? id)
      containers.push({
        id: id.slice(0, 12),
        name: name ?? "",
        image: image ?? "",
        status: status ?? "",
        ports: ports ?? "",
        restartPolicy: inspected.restartPolicy ?? undefined,
        hasModelVolume: inspected.hasModelVolume,
        isOurs: name === config.containerName,
      })
    }
    return containers
  } catch {
    return []
  }
}

export async function stopManagedVisionContainer(config: VisionConfig): Promise<{ ok: boolean; message: string }> {
  const status = await getManagedVisionStatus(config)
  if (status === "not_found" || status === "docker_error") {
    return { ok: true, message: "Vision no está desplegado." }
  }
  try {
    await execFileAsync("docker", ["stop", config.containerName], { timeout: 15_000 })
    return { ok: true, message: "Servicio Vision detenido." }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Error deteniendo Vision: ${message}` }
  }
}

export async function removeManagedVisionContainer(config: VisionConfig): Promise<{ ok: boolean; message: string }> {
  const status = await getManagedVisionStatus(config)
  if (status === "not_found") {
    return { ok: true, message: "Vision no está desplegado." }
  }
  try {
    await execFileAsync("docker", ["rm", "-f", config.containerName], { timeout: 15_000 })
    return { ok: true, message: `Contenedor ${config.containerName} eliminado.` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Error eliminando ${config.containerName}: ${message}` }
  }
}

export async function deployManagedVisionContainer(config: VisionConfig): Promise<{ ok: boolean; message: string; baseUrl: string }> {
  const baseUrl = getManagedVisionBaseUrl(config)
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 })
  } catch {
    return { ok: false, message: "Docker no está disponible o no está corriendo.", baseUrl }
  }

  const status = await getManagedVisionStatus(config)
  if (status === "running" && await probeManagedVision(config)) {
    const inspected = await inspectVisionContainer(config.containerName)
    if (!inspected.hasModelVolume) {
      const removed = await removeManagedVisionContainer(config)
      if (!removed.ok) return { ok: false, message: `Vision necesita recrearse con cache persistente, pero no pudo removerse: ${removed.message}`, baseUrl }
    } else {
      const repaired = await ensureRestartPolicy(config.containerName).catch(() => false)
      try {
        await execFileAsync("docker", ["exec", config.containerName, "ollama", "pull", config.model], { timeout: 300_000 })
        return {
          ok: true,
          message: `Vision ya está corriendo en ${baseUrl}. Modelo ${config.model} disponible.${repaired ? " Restart policy reparada a unless-stopped." : ""}`,
          baseUrl,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, message: `Vision está corriendo pero no pudo preparar el modelo ${config.model}: ${message}`, baseUrl }
      }
    }
  }

  let currentStatus = await getManagedVisionStatus(config)
  if (currentStatus === "running" && await probeManagedVision(config)) {
    try {
      await execFileAsync("docker", ["exec", config.containerName, "ollama", "pull", config.model], { timeout: 300_000 })
      return { ok: true, message: `Vision ya está corriendo en ${baseUrl}. Modelo ${config.model} disponible.`, baseUrl }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `Vision está corriendo pero no pudo preparar el modelo ${config.model}: ${message}`, baseUrl }
    }
  }
  if (currentStatus === "running") {
    const removed = await removeManagedVisionContainer(config)
    if (!removed.ok) return { ok: false, message: `Vision está corriendo pero no responde; no pudo recrearse: ${removed.message}`, baseUrl }
    currentStatus = await getManagedVisionStatus(config)
  }

  if (currentStatus === "stopped") {
    const inspected = await inspectVisionContainer(config.containerName)
    if (!inspected.hasModelVolume) {
      await removeManagedVisionContainer(config)
    } else {
      await ensureRestartPolicy(config.containerName).catch(() => false)
    }
  }

  const nextStatus = await getManagedVisionStatus(config)
  if (nextStatus === "stopped") {
    try {
      await execFileAsync("docker", ["start", config.containerName], { timeout: 30_000 })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `No se pudo iniciar el contenedor Vision: ${message}`, baseUrl }
    }
  } else if (nextStatus === "not_found") {
    const modelDir = getManagedVisionModelDir()
    mkdirSync(modelDir, { recursive: true })
    try {
      await execFileAsync("docker", [
        "run", "-d",
        "--name", config.containerName,
        "-p", `127.0.0.1:${config.port}:11434`,
        "--restart", "unless-stopped",
        "-v", `${modelDir}:/root/.ollama`,
        "ollama/ollama",
      ], { timeout: 120_000 })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `No se pudo crear el contenedor Vision: ${message}`, baseUrl }
    }
  } else if (nextStatus === "docker_error") {
    return { ok: false, message: "Docker no pudo consultar el estado del contenedor Vision.", baseUrl }
  }

  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (await probeManagedVision(config)) break
    if (i === 59) return { ok: false, message: "Vision no respondió dentro de 60s.", baseUrl }
  }

  try {
    await execFileAsync("docker", ["exec", config.containerName, "ollama", "pull", config.model], { timeout: 300_000 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `No se pudo descargar el modelo Vision ${config.model}: ${message}`, baseUrl }
  }

  return { ok: true, message: `Vision desplegado en ${baseUrl} con modelo ${config.model}.`, baseUrl }
}

export async function analyzeManagedImage(filePath: string, config: VisionConfig): Promise<string> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const base64Image = readFileSync(filePath).toString("base64")
  let response: Response
  try {
    response = await fetch(`${getManagedVisionBaseUrl(config)}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        prompt: "Describe exactly what is in this image in detail. Extract any text visible.",
        images: [base64Image],
        stream: false,
      }),
      signal: AbortSignal.timeout(180_000),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Local vision service unavailable: ${message}`)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Vision request failed: HTTP ${response.status}${body ? ` - ${body.slice(0, 400)}` : ""}`)
  }

  const payload = await response.json() as { response?: string }
  return typeof payload.response === "string" ? payload.response.trim() : ""
}
