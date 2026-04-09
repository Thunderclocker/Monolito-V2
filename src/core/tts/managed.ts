import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { TtsConfig } from "../channels/config.ts"

const execFileAsync = promisify(execFile)
const TTS_RESPONSE_FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"])

export type ManagedTtsStatus = "running" | "stopped" | "not_found" | "docker_error"

export type ManagedTtsContainerInfo = {
  id: string
  name: string
  image: string
  status: string
  isOurs: boolean
}

export function normalizeTtsConfig(config?: Partial<TtsConfig>): TtsConfig {
  const port = typeof config?.port === "number" && Number.isFinite(config.port) && config.port > 0 && config.port <= 65535
    ? Math.trunc(config.port)
    : 5050
  return {
    baseUrl: typeof config?.baseUrl === "string" ? config.baseUrl.trim() : "",
    apiKey: typeof config?.apiKey === "string" ? config.apiKey.trim() : "monolito-tts",
    voice: typeof config?.voice === "string" && config.voice.trim() ? config.voice.trim() : "es-AR-ElenaNeural",
    model: typeof config?.model === "string" && config.model.trim() ? config.model.trim() : "tts-1",
    responseFormat:
      typeof config?.responseFormat === "string" && TTS_RESPONSE_FORMATS.has(config.responseFormat)
        ? config.responseFormat
        : "mp3",
    speed:
      typeof config?.speed === "number" && Number.isFinite(config.speed) && config.speed > 0
        ? config.speed
        : 1,
    managed: typeof config?.managed === "boolean" ? config.managed : false,
    autoDeploy: typeof config?.autoDeploy === "boolean" ? config.autoDeploy : true,
    port,
    image: typeof config?.image === "string" && config.image.trim() ? config.image.trim() : "travisvn/openai-edge-tts:latest",
    containerName: typeof config?.containerName === "string" && config.containerName.trim() ? config.containerName.trim() : "monolito-openai-edge-tts",
  }
}

export function getManagedTtsBaseUrl(config: TtsConfig) {
  return `http://127.0.0.1:${config.port}`
}

async function probeManagedTts(config: TtsConfig) {
  try {
    const response = await fetch(`${getManagedTtsBaseUrl(config)}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        input: "ping",
        voice: config.voice,
        response_format: "mp3",
        speed: 1,
      }),
      signal: AbortSignal.timeout(5_000),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function findManagedTtsContainers(config: TtsConfig): Promise<ManagedTtsContainerInfo[]> {
  try {
    const { stdout: byImage } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", `ancestor=${config.image}`,
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
    ], { timeout: 10_000 })
    const { stdout: byName } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", `name=${config.containerName}`,
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
    ], { timeout: 10_000 })
    const { stdout: legacyByName } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", "name=tts-edge",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
    ], { timeout: 10_000 })
    const { stdout: legacyByImage } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", "ancestor=travisvn/openai-edge-tts:latest",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
    ], { timeout: 10_000 })

    const seen = new Set<string>()
    const containers: ManagedTtsContainerInfo[] = []
    for (const line of [...byImage.trim().split("\n"), ...byName.trim().split("\n"), ...legacyByName.trim().split("\n"), ...legacyByImage.trim().split("\n")]) {
      if (!line.trim()) continue
      const [id, name, image, status] = line.split("\t")
      if (!id || seen.has(id)) continue
      seen.add(id)
      containers.push({
        id: id.slice(0, 12),
        name: name ?? "",
        image: image ?? "",
        status: status ?? "",
        isOurs: name === config.containerName,
      })
    }
    return containers
  } catch {
    return []
  }
}

export async function getManagedTtsStatus(config: TtsConfig): Promise<ManagedTtsStatus> {
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

export async function listManagedTtsContainers(config: TtsConfig): Promise<string> {
  const containers = await findManagedTtsContainers(config)
  if (containers.length === 0) return "No se encontraron contenedores TTS."
  return [
    `Contenedores TTS encontrados: ${containers.length}`,
    ...containers.map(container =>
      `- ${container.name || "(sin nombre)"} | ${container.id} | ${container.image} | ${container.status}${container.isOurs ? " | managed" : ""}`),
  ].join("\n")
}

export async function stopManagedTtsContainer(config: TtsConfig): Promise<{ ok: boolean; message: string }> {
  const status = await getManagedTtsStatus(config)
  if (status === "not_found" || status === "docker_error") {
    return { ok: true, message: "TTS no está desplegado." }
  }
  try {
    await execFileAsync("docker", ["stop", config.containerName], { timeout: 15_000 })
    return { ok: true, message: "Servicio TTS detenido." }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Error deteniendo TTS: ${message}` }
  }
}

export async function removeManagedTtsContainer(config: TtsConfig, idOrName?: string): Promise<{ ok: boolean; message: string }> {
  let target = idOrName ?? config.containerName
  if (target === config.containerName) {
    const containers = await findManagedTtsContainers(config)
    const ours = containers.find(container => container.isOurs)
    if (!ours) {
      return { ok: true, message: "TTS no está desplegado." }
    }
    target = ours.id
  }
  try {
    await execFileAsync("docker", ["rm", "-f", target], { timeout: 15_000 })
    return { ok: true, message: `Contenedor ${target} eliminado.` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Error eliminando ${target}: ${message}` }
  }
}

export async function deployManagedTtsContainer(config: TtsConfig): Promise<{ ok: boolean; message: string; baseUrl: string }> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 })
  } catch {
    return { ok: false, message: "Docker no está disponible o no está corriendo.", baseUrl: getManagedTtsBaseUrl(config) }
  }

  const baseUrl = getManagedTtsBaseUrl(config)
  const status = await getManagedTtsStatus(config)
  if (status === "running" && await probeManagedTts(config)) {
    return { ok: true, message: `TTS ya está corriendo en ${baseUrl}.`, baseUrl }
  }

  const containers = await findManagedTtsContainers(config)
  for (const container of containers.filter(item => !item.isOurs)) {
    await removeManagedTtsContainer(config, container.id)
  }

  if (status === "running" || status === "stopped") {
    await removeManagedTtsContainer(config, config.containerName)
  }

  try {
    await execFileAsync("docker", [
      "run", "-d",
      "--name", config.containerName,
      "-p", `127.0.0.1:${config.port}:5050`,
      "--restart", "unless-stopped",
      "-e", `PORT=5050`,
      "-e", `API_KEY=${config.apiKey}`,
      "-e", `DEFAULT_VOICE=${config.voice}`,
      config.image,
    ], { timeout: 120_000 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Error desplegando TTS: ${message}`, baseUrl }
  }

  for (let i = 0; i < 25; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (await probeManagedTts(config)) {
      return { ok: true, message: `TTS desplegado en ${baseUrl}.`, baseUrl }
    }
  }

  return { ok: false, message: "TTS se inició pero no respondió dentro de 25s.", baseUrl }
}
