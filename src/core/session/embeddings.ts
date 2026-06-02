import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type Database from "better-sqlite3"
import crypto from "node:crypto"
import { createLogger } from "../logging/logger.ts"

const logger = createLogger("embeddings")

const execFileAsync = promisify(execFile)

const OLLAMA_URL = "http://127.0.0.1:11434"
const OLLAMA_CONTAINER = "monolito-v2-ollama-embeddings"
const OLLAMA_IMAGE = "ollama/ollama"
export const OLLAMA_MODEL = "bge-m3"
const EMBEDDING_DIMENSIONS = 1024
const OLLAMA_START_TIMEOUT_MS = 45_000
const OLLAMA_PULL_TIMEOUT_MS = 300_000

type EmbeddingWarmupState = "idle" | "warming" | "ready" | "failed"

let state: EmbeddingWarmupState = "idle"
let lastError: string | null = null
let pending: Promise<void> | null = null
let semanticDb: Database.Database | null = null
let detectedModel: string | null = null

const activeRequests = new Map<string, Promise<Float32Array>>()

function normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < vector.length; i++) {
    sum += vector[i] * vector[i]
  }
  const magnitude = Math.sqrt(sum)
  if (magnitude === 0) return vector
  for (let i = 0; i < vector.length; i++) {
    vector[i] /= magnitude
  }
  return vector
}

function computeTextHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

function pruneEmbeddingCacheIfNeeded() {
  if (!semanticDb) return
  try {
    const maxEntries = 10000
    const row = semanticDb.prepare(`SELECT COUNT(*) as c FROM embedding_cache`).get() as { c: number } | undefined
    const count = row?.c ?? 0
    if (count > maxEntries) {
      const excess = count - maxEntries
      semanticDb.prepare(`
        DELETE FROM embedding_cache 
        WHERE rowid IN (
          SELECT rowid FROM embedding_cache 
          ORDER BY updated_at ASC 
          LIMIT ?
        )
      `).run(excess)
    }
  } catch {
    // Fail-safe
  }
}

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

let mockGenerator: ((text: string) => Promise<Float32Array>) | null = null

export function setMockEmbeddingGenerator(mock: typeof mockGenerator) {
  mockGenerator = mock
}

function sanitizeTextForOllama(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  if (mockGenerator) {
    return mockGenerator(text)
  }
  const normalizedText = text.trim()
  if (!normalizedText) {
    return new Float32Array(EMBEDDING_DIMENSIONS)
  }

  const hash = computeTextHash(normalizedText)

  // 1. Check in-memory de-duplication first
  if (activeRequests.has(hash)) {
    return await activeRequests.get(hash)!
  }

  const promise = (async () => {
    // 2. Check SQLite cache
    if (semanticDb) {
      try {
        const row = semanticDb.prepare(`
          SELECT embedding FROM embedding_cache 
          WHERE provider = 'ollama' AND model = ? AND hash = ?
          LIMIT 1
        `).get(OLLAMA_MODEL, hash) as { embedding: string } | undefined
        if (row?.embedding) {
          const parsed = JSON.parse(row.embedding)
          if (Array.isArray(parsed) && parsed.length === EMBEDDING_DIMENSIONS) {
            // Update updated_at for LRU eviction
            semanticDb.prepare(`
              UPDATE embedding_cache SET updated_at = ? 
              WHERE provider = 'ollama' AND model = ? AND hash = ?
            `).run(Date.now(), OLLAMA_MODEL, hash)
            return normalize(Float32Array.from(parsed))
          }
        }
      } catch (err) {
        // Fallback to Ollama if cache query fails
      }
    }

    // 3. Fallback to Ollama fetch (cache miss)
    try {
      await ensureEmbeddingsReady()
      let embeddingArray: number[]
      try {
        const res = await ollamaFetch("/api/embeddings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: OLLAMA_MODEL, prompt: normalizedText }),
        })
        const payload = await res.json() as { embedding?: number[] }
        if (!Array.isArray(payload.embedding)) {
          throw new Error("Ollama embedding response did not include an embedding array")
        }
        if (payload.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(`Expected ${EMBEDDING_DIMENSIONS} dimensions from ${OLLAMA_MODEL}, got ${payload.embedding.length}`)
        }
        if (payload.embedding.some(v => typeof v !== "number" || Number.isNaN(v))) {
          throw new Error("Ollama embedding response contains NaN values")
        }
        embeddingArray = payload.embedding
      } catch (firstError) {
        const errorMsg = firstError instanceof Error ? firstError.message : String(firstError)
        if (errorMsg.includes("500") || errorMsg.includes("NaN") || errorMsg.includes("Ollama")) {
          const sanitized = sanitizeTextForOllama(normalizedText)
          if (sanitized && sanitized !== normalizedText) {
            try {
              const res = await ollamaFetch("/api/embeddings", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model: OLLAMA_MODEL, prompt: sanitized }),
              })
              const payload = await res.json() as { embedding?: number[] }
              if (!Array.isArray(payload.embedding)) {
                throw new Error("Ollama embedding response did not include an embedding array")
              }
              if (payload.embedding.length !== EMBEDDING_DIMENSIONS) {
                throw new Error(`Expected ${EMBEDDING_DIMENSIONS} dimensions from ${OLLAMA_MODEL}, got ${payload.embedding.length}`)
              }
              if (payload.embedding.some(v => typeof v !== "number" || Number.isNaN(v))) {
                throw new Error("Ollama embedding response contains NaN values")
              }
              embeddingArray = payload.embedding
            } catch (secondError) {
              logger.warn(`Failed to generate embedding for prompt after sanitization. Returning zero-vector. Error: ${secondError}`)
              return new Float32Array(EMBEDDING_DIMENSIONS)
            }
          } else {
            logger.warn(`Failed to generate embedding for prompt (cannot sanitize further). Returning zero-vector. Error: ${firstError}`)
            return new Float32Array(EMBEDDING_DIMENSIONS)
          }
        } else {
          throw firstError
        }
      }

      const floatArray = normalize(Float32Array.from(embeddingArray))

      // Save to SQLite cache asynchronously
      if (semanticDb) {
        try {
          semanticDb.prepare(`
            INSERT INTO embedding_cache (provider, model, hash, embedding, dims, updated_at)
            VALUES ('ollama', ?, ?, ?, ?, ?)
            ON CONFLICT(provider, model, hash) DO UPDATE SET
              embedding = excluded.embedding,
              dims = excluded.dims,
              updated_at = excluded.updated_at
          `).run(OLLAMA_MODEL, hash, JSON.stringify(Array.from(floatArray)), EMBEDDING_DIMENSIONS, Date.now())
          pruneEmbeddingCacheIfNeeded()
        } catch {
          // Fail-safe
        }
      }

      return floatArray
    } catch (error) {
      throw toEmbeddingsError(error)
    }
  })()

  activeRequests.set(hash, promise)
  try {
    return await promise
  } finally {
    activeRequests.delete(hash)
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
