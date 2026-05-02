import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type Database from "better-sqlite3"

const execFileAsync = promisify(execFile)

const OLLAMA_URL = "http://127.0.0.1:11434"
const OLLAMA_CONTAINER = "monolito-v2-ollama-embeddings"
const OLLAMA_IMAGE = "ollama/ollama"
export const OLLAMA_MODEL = "nomic-embed-text"
const EMBEDDING_DIMENSIONS = 768
const OLLAMA_START_TIMEOUT_MS = 45_000
const OLLAMA_PULL_TIMEOUT_MS = 300_000

type EmbeddingWarmupState = "idle" | "warming" | "ready" | "failed"

let state: EmbeddingWarmupState = "idle"
let lastError: string | null = null
let pending: Promise<void> | null = null
let semanticDb: Database.Database | null = null
let detectedModel: string | null = null

function toEmbeddingsError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`Embeddings unavailable: ${message}`)
}

export function isEmbeddingsUnavailableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith("Embeddings unavailable:")
}

export function bindSemanticSearchDb(db: Database.Database) {
  semanticDb = db
}

export function getEmbeddingsStatus() {
  return {
    state,
    model: detectedModel ?? OLLAMA_MODEL,
    baseUrl: OLLAMA_URL,
    dimensions: EMBEDDING_DIMENSIONS,
    lastError,
  }
}

async function ollamaFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${OLLAMA_URL}${path}`, init)
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Ollama ${path} failed with HTTP ${response.status}${text ? `: ${text}` : ""}`)
  }
  return response
}

async function waitForOllama(timeoutMs = OLLAMA_START_TIMEOUT_MS) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      await ollamaFetch("/api/tags")
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 750))
    }
  }
  throw new Error(`Ollama did not become ready on ${OLLAMA_URL} within ${timeoutMs}ms`)
}

async function isLocalOllamaReady() {
  try {
    await ollamaFetch("/api/tags")
    return true
  } catch {
    return false
  }
}

async function ensureDockerOllama() {
  await execFileAsync("docker", ["info"], { timeout: 10_000 })

  const { stdout } = await execFileAsync("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^/${OLLAMA_CONTAINER}$`,
    "--format",
    "{{.Status}}",
  ], { timeout: 10_000 })

  if (stdout.trim()) {
    if (!stdout.trim().toLowerCase().startsWith("up")) {
      await execFileAsync("docker", ["start", OLLAMA_CONTAINER], { timeout: 30_000 })
    }
    await waitForOllama()
    return
  }

  await execFileAsync("docker", [
    "run",
    "-d",
    "--name",
    OLLAMA_CONTAINER,
    "-p",
    "11434:11434",
    "-v",
    "monolito-v2-ollama:/root/.ollama",
    OLLAMA_IMAGE,
  ], { timeout: 60_000 })
  await waitForOllama()
}

async function ensureModelPulled() {
  const tags = await ollamaFetch("/api/tags").then(response => response.json()) as { models?: Array<{ name?: string; model?: string }> }
  const modelEntry = tags.models?.find(model => (model.name ?? model.model ?? "").split(":")[0] === OLLAMA_MODEL)
  if (modelEntry) {
    detectedModel = (modelEntry.name ?? modelEntry.model ?? OLLAMA_MODEL).split(":")[0]
  } else {
    detectedModel = OLLAMA_MODEL
  }
  if (!modelEntry) {
    await ollamaFetch("/api/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: false }),
      signal: AbortSignal.timeout(OLLAMA_PULL_TIMEOUT_MS),
    })
  }
}

async function ensureEmbeddingsReady() {
  if (state === "ready") return
  if (pending) return await pending

  state = "warming"
  lastError = null
  pending = (async () => {
    try {
      if (!await isLocalOllamaReady()) {
        await ensureDockerOllama()
      }
      await ensureModelPulled()
      state = "ready"
    } catch (error) {
      state = "failed"
      lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      pending = null
    }
  })()

  return await pending
}

export async function warmupEmbeddings(_rootDir?: string) {
  try {
    await ensureEmbeddingsReady()
    return { ok: true as const, ...getEmbeddingsStatus() }
  } catch (error) {
    return {
      ok: false as const,
      ...getEmbeddingsStatus(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function initEmbeddingEngine(): Promise<{ ok: boolean; state: EmbeddingWarmupState; model: string; baseUrl: string; dimensions: number; error?: string }> {
  try {
    await ensureEmbeddingsReady()
    return { ok: true, ...getEmbeddingsStatus() }
  } catch (error) {
    return {
      ok: false,
      ...getEmbeddingsStatus(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  try {
    await ensureEmbeddingsReady()
    const response = await ollamaFetch("/api/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
    })
    const payload = await response.json() as { embedding?: number[] }
    if (!Array.isArray(payload.embedding)) throw new Error("Ollama embedding response did not include an embedding array")
    if (payload.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Expected ${EMBEDDING_DIMENSIONS} dimensions from ${OLLAMA_MODEL}, got ${payload.embedding.length}`)
    }
    return Float32Array.from(payload.embedding)
  } catch (error) {
    throw toEmbeddingsError(error)
  }
}

export function searchSemantically(vector: number[] | Float32Array, limit = 10): number[] {
  if (!semanticDb) throw toEmbeddingsError(new Error("Semantic SQLite database is not bound"))
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw toEmbeddingsError(new Error(`Semantic query vector must have ${EMBEDDING_DIMENSIONS} dimensions, got ${vector.length}`))
  }
  const rows = semanticDb.prepare(`
    SELECT id
    FROM vec_messages
    WHERE embedding MATCH ? AND k = ?
    ORDER BY distance ASC
  `).all(vector instanceof Float32Array ? vector : Float32Array.from(vector), limit) as Array<{ id: number }>
  return rows.map(row => row.id)
}
