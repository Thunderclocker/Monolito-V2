import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { SttConfig } from "../channels/config.ts"

const execFileAsync = promisify(execFile)

export type ManagedSttStatus = "running" | "stopped" | "not_found" | "docker_error"

export type ManagedSttContainerInfo = {
  id: string
  name: string
  image: string
  status: string
  isOurs: boolean
}

export type SttTranscriptResult = {
  ok: boolean
  text: string
  language?: string
  segments?: unknown[]
  service?: string
  error?: string
}

export function normalizeSttConfig(config?: Partial<SttConfig>): SttConfig {
  const port = typeof config?.port === "number" && Number.isFinite(config.port) && config.port > 0 && config.port <= 65535
    ? Math.trunc(config.port)
    : 9000
  return {
    managed: typeof config?.managed === "boolean" ? config.managed : true,
    autoDeploy: typeof config?.autoDeploy === "boolean" ? config.autoDeploy : true,
    autoTranscribe: typeof config?.autoTranscribe === "boolean" ? config.autoTranscribe : true,
    port,
    image: typeof config?.image === "string" && config.image.trim() ? config.image.trim() : "onerahmet/openai-whisper-asr-webservice:latest",
    containerName: typeof config?.containerName === "string" && config.containerName.trim() ? config.containerName.trim() : "monolito-faster-whisper",
    engine:
      config?.engine === "faster_whisper" || config?.engine === "openai_whisper" || config?.engine === "whisperx"
        ? config.engine
        : "faster_whisper",
    model: typeof config?.model === "string" && config.model.trim() ? config.model.trim() : "small",
    language: typeof config?.language === "string" && config.language.trim() ? config.language.trim() : "es",
    vadFilter: typeof config?.vadFilter === "boolean" ? config.vadFilter : true,
  }
}

export function getManagedSttBaseUrl(config: SttConfig) {
  return `http://127.0.0.1:${config.port}`
}

async function probeManagedStt(config: SttConfig) {
  try {
    const response = await fetch(`${getManagedSttBaseUrl(config)}/docs`, {
      signal: AbortSignal.timeout(4_000),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function findManagedSttContainers(config: SttConfig): Promise<ManagedSttContainerInfo[]> {
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
    const { stdout: legacyWhisper } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", "ancestor=onerahmet/openai-whisper-asr-webservice:latest",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
    ], { timeout: 10_000 })
    const { stdout: legacyByName } = await execFileAsync("docker", [
      "ps", "-a",
      "--filter", "name=whisper",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
    ], { timeout: 10_000 })

    const seen = new Set<string>()
    const containers: ManagedSttContainerInfo[] = []
    for (const line of [...byImage.trim().split("\n"), ...byName.trim().split("\n"), ...legacyWhisper.trim().split("\n"), ...legacyByName.trim().split("\n")]) {
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

export async function getManagedSttStatus(config: SttConfig): Promise<ManagedSttStatus> {
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

export async function listManagedSttContainers(config: SttConfig): Promise<string> {
  const containers = await findManagedSttContainers(config)
  if (containers.length === 0) return "No se encontraron contenedores STT."
  return [
    `Contenedores STT encontrados: ${containers.length}`,
    ...containers.map(container =>
      `- ${container.name || "(sin nombre)"} | ${container.id} | ${container.image} | ${container.status}${container.isOurs ? " | managed" : ""}`),
  ].join("\n")
}

export async function stopManagedSttContainer(config: SttConfig): Promise<{ ok: boolean; message: string }> {
  const status = await getManagedSttStatus(config)
  if (status === "not_found" || status === "docker_error") {
    return { ok: true, message: "STT no está desplegado." }
  }
  try {
    await execFileAsync("docker", ["stop", config.containerName], { timeout: 15_000 })
    return { ok: true, message: "Servicio STT detenido." }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Error deteniendo STT: ${message}` }
  }
}

export async function removeManagedSttContainer(config: SttConfig, idOrName?: string): Promise<{ ok: boolean; message: string }> {
  let target = idOrName ?? config.containerName
  if (target === config.containerName) {
    const containers = await findManagedSttContainers(config)
    const ours = containers.find(container => container.isOurs)
    if (!ours) {
      return { ok: true, message: "STT no está desplegado." }
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

export async function deployManagedSttContainer(config: SttConfig): Promise<{ ok: boolean; message: string; baseUrl: string }> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 })
  } catch {
    return { ok: false, message: "Docker no está disponible o no está corriendo.", baseUrl: getManagedSttBaseUrl(config) }
  }

  const baseUrl = getManagedSttBaseUrl(config)
  const status = await getManagedSttStatus(config)
  if (status === "running" && await probeManagedStt(config)) {
    return { ok: true, message: `STT ya está corriendo en ${baseUrl}.`, baseUrl }
  }

  const containers = await findManagedSttContainers(config)
  for (const container of containers.filter(item => !item.isOurs)) {
    await removeManagedSttContainer(config, container.id)
  }

  if (status === "running" || status === "stopped") {
    await removeManagedSttContainer(config, config.containerName)
  }

  const cacheDir = join(homedir(), ".monolito-v2", "stt-cache")
  mkdirSync(cacheDir, { recursive: true })

  try {
    await execFileAsync("docker", [
      "run", "-d",
      "--name", config.containerName,
      "-p", `127.0.0.1:${config.port}:9000`,
      "--restart", "unless-stopped",
      "-e", `ASR_ENGINE=${config.engine}`,
      "-e", `ASR_MODEL=${config.model}`,
      "-e", "ASR_DEVICE=cpu",
      "-v", `${cacheDir}:/root/.cache/`,
      config.image,
    ], { timeout: 120_000 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Error desplegando STT: ${message}`, baseUrl }
  }

  for (let i = 0; i < 45; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (await probeManagedStt(config)) {
      return { ok: true, message: `STT desplegado en ${baseUrl}.`, baseUrl }
    }
  }

  return { ok: false, message: "STT se inició pero no respondió dentro de 45s.", baseUrl }
}

export async function transcribeManagedAudioFile(filePath: string, config: SttConfig): Promise<SttTranscriptResult> {
  if (!existsSync(filePath)) {
    return { ok: false, text: "", error: `File not found: ${filePath}` }
  }

  const baseUrl = getManagedSttBaseUrl(config)
  const fileData = readFileSync(filePath)
  const fileName = filePath.split("/").at(-1) ?? "audio.bin"
  const form = new FormData()
  form.append("audio_file", new Blob([fileData]), fileName)
  const query = new URLSearchParams({
    output: "json",
    task: "transcribe",
    encode: "true",
  })
  if (config.language) query.set("language", config.language)
  if (config.engine === "faster_whisper" && config.vadFilter) query.set("vad_filter", "true")

  const response = await fetch(`${baseUrl}/asr?${query.toString()}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(180_000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    return { ok: false, text: "", error: `STT request failed: HTTP ${response.status}${body ? ` - ${body.slice(0, 400)}` : ""}` }
  }

  const payload = await response.json() as { text?: string; language?: string; segments?: unknown[] }
  return {
    ok: true,
    text: typeof payload.text === "string" ? payload.text.trim() : "",
    language: typeof payload.language === "string" ? payload.language : undefined,
    segments: Array.isArray(payload.segments) ? payload.segments : undefined,
    service: "managed_stt",
  }
}
