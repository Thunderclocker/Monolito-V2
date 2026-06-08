// Multi-chunk embeddings for long memory drawers.
//
// Gated by env var MONOLITO_USE_MULTI_CHUNK_EMBEDDINGS:
//   - 0 (default): legacy path. fileMemory sends full content to Ollama in
//     one call. If content > bge-m3 num_ctx (8192 tokens), Ollama returns
//     HTTP 500 and the wrapper falls back to a zero-vector.
//   - 1: content is chunked (1500 tokens target, 150 overlap) and one vector
//     is stored per chunk in vec_drawer_chunks. The legacy vec_drawers row
//     keeps a fallback vector (first chunk) so existing recall paths still
//     find the drawer via the approximate legacy embedding.
//
// The two paths can coexist because vec_drawer_chunks is additive: the old
// vec_drawers table is never modified when the new path is on, only augmented.

import type Database from "better-sqlite3"
import { chunk, type Chunk } from "../utils/chunker.ts"
import { generateEmbedding } from "./embeddings.ts"
import { createLogger } from "../logging/logger.ts"

const logger = createLogger("multiChunkEmbeddings")

/** Read the feature flag. Default: off (legacy path). */
export function isMultiChunkEmbeddingsEnabled(): boolean {
  const v = (process.env.MONOLITO_USE_MULTI_CHUNK_EMBEDDINGS ?? "0").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes"
}

export interface ChunkedEmbedding {
  index: number
  text: string
  embedding: Float32Array
}

/**
 * Chunk a long text and embed each chunk. Returns ONE vector per chunk.
 *
 * Robustness: if a single chunk's embedding fails (e.g. transient Ollama 500),
 * that chunk is skipped and a warn is logged. The others still get embedded.
 * The function never throws for partial failures.
 */
export async function embedChunked(
  text: string,
  opts: { targetTokens?: number; overlapTokens?: number } = {},
): Promise<ChunkedEmbedding[]> {
  const targetTokens = opts.targetTokens ?? 1500
  const overlapTokens = opts.overlapTokens ?? 150
  const chunks = chunk(text, { targetTokens, overlapTokens })
  const results: ChunkedEmbedding[] = []
  for (const c of chunks as Chunk[]) {
    try {
      const embedding = await generateEmbedding(c.text)
      // generateEmbedding returns a zero-vector on failure. Detect that
      // and skip — we don't want a poison entry in the multi-vector table.
      if (isZeroVector(embedding)) {
        logger.warn("multiChunkEmbeddings: skipping chunk with zero-vector embedding", {
          chunkIndex: c.index,
          chunkLength: c.text.length,
        })
        continue
      }
      results.push({ index: c.index, text: c.text, embedding })
    } catch (e) {
      logger.warn("multiChunkEmbeddings: chunk embedding failed, skipping", {
        chunkIndex: c.index,
        errorName: e instanceof Error ? e.name : "Error",
        errorMessage: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return results
}

function isZeroVector(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== 0) return false
  }
  return true
}

/** Insert one row per chunk into vec_drawer_chunks. Idempotent (INSERT OR IGNORE). */
export function insertChunkEmbeddings(
  db: Database.Database,
  drawerRowid: number | bigint,
  chunked: ChunkedEmbedding[],
): number {
  if (chunked.length === 0) return 0
  const rowid = typeof drawerRowid === "bigint" ? drawerRowid : BigInt(drawerRowid)
  let inserted = 0
  for (const c of chunked) {
    // Step 1: upsert meta row to get a stable chunk_id.
    // INSERT OR IGNORE returns the existing chunk_id if (rowid, c.index) is
    // already present, otherwise inserts and returns the new rowid.
    const metaRow = db
      .prepare(
        `INSERT OR IGNORE INTO drawer_chunk_meta (drawer_rowid, chunk_index) VALUES (?, ?)`,
      )
      .run(rowid, c.index)
    const chunkId = db
      .prepare(
        `SELECT chunk_id FROM drawer_chunk_meta WHERE drawer_rowid = ? AND chunk_index = ?`,
      )
      .get(rowid, c.index) as { chunk_id: number } | undefined
    if (!chunkId) {
      // Should not happen — we just inserted. Bail to avoid corrupting vec0.
      continue
    }
    // Step 2: insert vector into vec0. INSERT OR IGNORE handles re-runs
    // (same chunk_id is a PK conflict, vector is preserved).
    const vecResult = db
      .prepare(`INSERT OR IGNORE INTO vec_drawer_chunks (id, embedding) VALUES (?, ?)`)
      .run(chunkId.chunk_id, c.embedding)
    if (vecResult.changes > 0) inserted++
    void metaRow // silence unused warning if linter is strict
  }
  return inserted
}

export interface RecallHit {
  drawerRowid: number
  drawerId: string
  profileId: string | null
  wing: string
  room: string
  memoryKey: string | null
  content: string
  createdAt: string
  /** Mean of the per-chunk distances for this drawer. Lower = better. */
  meanDistance: number
  /** How many chunks of this drawer matched (max 1, more if multiple chunks matched). */
  matchedChunks: number
}

/**
 * Multi-chunk semantic recall. Returns top drawers by mean chunk distance.
 *
 * Algorithm:
 * 1. MATCH against vec_drawer_chunks with k = 200 (oversample).
 * 2. Group by drawer_rowid, compute mean distance per drawer.
 * 3. ORDER BY mean distance ASC, LIMIT 15.
 */
export function recallMultiChunk(
  db: Database.Database,
  queryVector: Float32Array,
  filter: {
    wing?: string
    room?: string
    key?: string
    profileId?: string
    excludeWings?: string[]
  } = {},
  limit = 15,
  k = 200,
): RecallHit[] {
  const params: unknown[] = [queryVector, k]
  const conditions: string[] = []
  if (filter.wing) {
    conditions.push(`m.wing = ?`)
    params.push(filter.wing)
  }
  if (filter.room) {
    conditions.push(`m.room = ?`)
    params.push(filter.room)
  }
  if (filter.key) {
    conditions.push(`m.memory_key = ?`)
    params.push(filter.key)
  }
  if (filter.profileId) {
    conditions.push(`(m.profile_id = ? OR m.profile_id IS NULL)`)
    params.push(filter.profileId)
  } else {
    conditions.push(`m.profile_id IS NULL`)
  }
  // Exclude system wings by default.
  const excluded = filter.excludeWings ?? ["BOOT_", "CONF_"]
  for (const prefix of excluded) {
    conditions.push(`m.wing NOT LIKE ? ESCAPE '\\'`)
    params.push(prefix.replace(/_/g, "\\_") + "%")
  }

  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : ""

  // Step 1: oversample chunks (vec0 returns id, which is chunk_id).
  const matches = db
    .prepare(
      `SELECT v.id AS chunk_id, v.distance
       FROM vec_drawer_chunks v
       WHERE v.embedding MATCH ? AND k = ?
       ${where}
       ORDER BY v.distance ASC`,
    )
    .all(...params) as Array<{ chunk_id: number; distance: number }>

  if (matches.length === 0) return []

  // Step 2: resolve chunk_id → drawer_rowid via drawer_chunk_meta, then group.
  const groups = new Map<number, { sum: number; count: number }>()
  const chunkIds = matches.map((m) => m.chunk_id)
  const placeholders = chunkIds.map(() => "?").join(",")
  const metaRows = db
    .prepare(
      `SELECT chunk_id, drawer_rowid FROM drawer_chunk_meta WHERE chunk_id IN (${placeholders})`,
    )
    .all(...chunkIds) as Array<{ chunk_id: number; drawer_rowid: number }>
  const chunkToDrawer = new Map<number, number>()
  for (const m of metaRows) {
    chunkToDrawer.set(m.chunk_id, m.drawer_rowid)
  }
  for (const m of matches) {
    const drawerRowid = chunkToDrawer.get(m.chunk_id)
    if (drawerRowid === undefined) continue
    const g = groups.get(drawerRowid) ?? { sum: 0, count: 0 }
    g.sum += m.distance
    g.count += 1
    groups.set(drawerRowid, g)
  }
  const drawerIds = [...groups.keys()]
  const drawerPlaceholders = drawerIds.map(() => "?").join(",")
  const rows = db
    .prepare(
      `SELECT rowid, id, profile_id, wing, room, memory_key, content, created_at
       FROM memory_drawers
       WHERE rowid IN (${drawerPlaceholders})`,
    )
    .all(...drawerIds) as Array<{
      rowid: number
      id: string
      profile_id: string | null
      wing: string
      room: string
      memory_key: string | null
      content: string
      created_at: string
    }>

  // Step 3: combine and sort
  const hits: RecallHit[] = []
  for (const row of rows) {
    const g = groups.get(row.rowid)
    if (!g) continue
    hits.push({
      drawerRowid: row.rowid,
      drawerId: row.id,
      profileId: row.profile_id,
      wing: row.wing,
      room: row.room,
      memoryKey: row.memory_key,
      content: row.content,
      createdAt: row.created_at,
      meanDistance: g.sum / g.count,
      matchedChunks: g.count,
    })
  }
  hits.sort((a, b) => a.meanDistance - b.meanDistance)
  return hits.slice(0, limit)
}
