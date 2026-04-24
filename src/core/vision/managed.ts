import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { promisify } from "node:util"
import type { VisionConfig } from "../channels/config.ts"

const execFileAsync = promisify(execFile)

export type ManagedVisionStatus = "running" | "stopped" | "not_found" | "docker_error"

export function normalizeVisionConfig(config?: Partial<VisionConfig>): VisionConfig {
  const port = typeof config?.port === "number" && Number.isFinite(config.port) && config.port > 0 && config.port <= 65535
    ? Math.trunc(config.port)
    : 11435
  return {
    managed: typeof config?.managed === "boolean" ? config.managed : false,
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
    try {
      await execFileAsync("docker", ["exec", config.containerName, "ollama", "pull", config.model], { timeout: 300_000 })
      return { ok: true, message: `Vision ya está corriendo en ${baseUrl}. Modelo ${config.model} disponible.`, baseUrl }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `Vision está corriendo pero no pudo preparar el modelo ${config.model}: ${message}`, baseUrl }
    }
  }

  if (status === "stopped") {
    try {
      await execFileAsync("docker", ["start", config.containerName], { timeout: 30_000 })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `No se pudo iniciar el contenedor Vision: ${message}`, baseUrl }
    }
  } else if (status === "not_found") {
    try {
      await execFileAsync("docker", [
        "run", "-d",
        "--name", config.containerName,
        "-p", `127.0.0.1:${config.port}:11434`,
        "--restart", "unless-stopped",
        "ollama/ollama",
      ], { timeout: 120_000 })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `No se pudo crear el contenedor Vision: ${message}`, baseUrl }
    }
  } else if (status === "docker_error") {
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
  const response = await fetch(`${getManagedVisionBaseUrl(config)}/api/generate`, {
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

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Vision request failed: HTTP ${response.status}${body ? ` - ${body.slice(0, 400)}` : ""}`)
  }

  const payload = await response.json() as { response?: string }
  return typeof payload.response === "string" ? payload.response.trim() : ""
}
