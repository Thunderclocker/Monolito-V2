// Incremental memory consolidation pipeline.
//
// Replaces the "tirarle 100K tokens al LLM" approach of the legacy
// runMemoryConsolidation in runtime.ts. Instead, we process drawers ONE
// AT A TIME, extract a structured ficha per drawer via LLM, and persist
// each ficha as a palace_node immediately. The LLM never sees more than
// one drawer at a time → no 100K-token overflow, no timeouts.
//
// Flow per drawer:
//   1. processor: send drawer's content to LLM, ask for a structured
//      ficha (topics, key_facts, action_items, person_refs). Timeout 30s.
//   2. sink: validate the JSON, then INSERT OR IGNORE into palace_nodes
//      with subject_type="memory_drawer_ficha", subject_id=drawer.id.
//
// The pipeline uses the same cursor/stream pattern as the rest of
// process-and-flush: if it crashes mid-drawer, the cursor points to
// the next unprocessed drawer. Re-runs are idempotent (the sink uses
// OR IGNORE on the natural unique constraint of palace_nodes).
//
// Feature flag: MONOLITO_USE_INCREMENTAL_CONSOLIDATION=1
//   Default: 0 (legacy runMemoryConsolidation).

import type Database from "better-sqlite3"
import { processStream, type PipelineResult } from "../utils/pipeline.ts"
import { getCursor } from "../utils/cursor.ts"
import { createLogger } from "../logging/logger.ts"

const logger = createLogger("memoryConsolidationPipeline")

/** Feature flag. */
export function isIncrementalConsolidationEnabled(): boolean {
  const v = (process.env.MONOLITO_USE_INCREMENTAL_CONSOLIDATION ?? "0").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes"
}

export interface DrawerRecord {
  id: string
  rowid: number
  wing: string
  room: string
  memory_key: string | null
  content: string
  created_at: string
}

export interface FichaRecord {
  topics: string[]
  key_facts: string[]
  action_items: string[]
  person_refs: string[]
}

export interface MemoryConsolidationOptions {
  /** Root dir for the Monolito DB. */
  rootDir: string
  /** Session ID (used in streamId). */
  sessionId: string
  /** Profile ID. */
  profileId: string
  /** How many drawers to process per invocation. Default: 20. */
  batchSize?: number
  /** Resume from cursor. Default: true. */
  resume?: boolean
  /** External AbortSignal. */
  abortSignal?: AbortSignal
  /**
   * LLM call. Injected so the runtime can reuse its existing modelAdapter
   * + cost-tracking + telemetry. Receives the drawer content, returns the
   * ficha as JSON. If the LLM fails or returns invalid JSON, the processor
   * returns null (skips the drawer with log warn) so the cursor advances.
   */
  llmExtractFicha: (drawerContent: string, drawerId: string) => Promise<string>
  /** Max ficha JSON size in chars (defensive). Default: 8000. */
  maxFichaChars?: number
}

/** Result of one consolidation pass. */
export interface MemoryConsolidationResult extends PipelineResult {
  drawersScanned: number
  fichasInserted: number
  fichasSkipped: number
}

/**
 * Run one incremental consolidation pass.
 *
 * The stream ID is deterministic per (sessionId, profileId), so the cursor
 * survives crashes and is shared across daemon restarts.
 */
export async function runMemoryConsolidationIncremental(
  db: Database.Database,
  opts: MemoryConsolidationOptions,
): Promise<MemoryConsolidationResult> {
  const streamId = `memcons:${opts.sessionId}:${opts.profileId}`
  const batchSize = opts.batchSize ?? 20
  const resume = opts.resume ?? true
  const maxFichaChars = opts.maxFichaChars ?? 8000

  // Load cursor (used for resume + bookkeeping).
  const cursor = getCursor(db, streamId)

  // Build the list of drawers to process.
  // We list ALL drawers for the profile, then let the pipeline's cursor logic
  // skip the ones already done.
  const allDrawers = listDrawersForProfile(db, opts.profileId, opts.rootDir)
  if (allDrawers.length === 0) {
    logger.info("memoryConsolidationPipeline: no drawers to consolidate", { streamId })
    return {
      streamId,
      totalProcessed: 0,
      totalErrors: 0,
      finalPosition: cursor.position,
      done: true,
      drawersScanned: 0,
      fichasInserted: 0,
      fichasSkipped: 0,
    }
  }

  // Convert drawers to "chunks" (one chunk per drawer). Each chunk carries
  // the drawer as metadata in its text field (JSON-encoded for transport).
  const source = allDrawers.map((d, i): {
    text: string
    startOffset: number
    endOffset: number
    index: number
    estimatedTokens: number
    isLast: boolean
  } => ({
    text: JSON.stringify(d),
    startOffset: i,
    endOffset: i + 1,
    index: i,
    estimatedTokens: Math.ceil(d.content.length / 3.5),
    isLast: i === allDrawers.length - 1,
  }))

  // Track per-run metrics.
  let fichasInserted = 0
  let fichasSkipped = 0

  const result = await processStream<FichaRecord>(db, {
    streamId,
    source,
    reset: !resume,
    abortSignal: opts.abortSignal,
    maxChunks: batchSize,
    processor: async (chunk) => {
      // chunk.text is JSON of the drawer.
      let drawer: DrawerRecord
      try {
        drawer = JSON.parse(chunk.text) as DrawerRecord
      } catch (e) {
        logger.warn("memoryConsolidationPipeline: malformed chunk text, skipping", {
          chunkIndex: chunk.index,
          errorMessage: e instanceof Error ? e.message : String(e),
        })
        fichasSkipped++
        return null
      }

      // Skip system wings (defensive — should already be excluded by the SQL).
      if (drawer.wing.toUpperCase().startsWith("BOOT_") || drawer.wing.toUpperCase().startsWith("CONF_")) {
        fichasSkipped++
        return null
      }

      // Call the LLM extractor.
      let raw: string
      try {
        raw = await opts.llmExtractFicha(drawer.content, drawer.id)
      } catch (e) {
        logger.warn("memoryConsolidationPipeline: LLM extractor failed, skipping drawer", {
          drawerId: drawer.id,
          errorMessage: e instanceof Error ? e.message : String(e),
        })
        fichasSkipped++
        return null
      }

      // Parse the JSON output. Be tolerant: the model sometimes wraps the JSON
      // in markdown fences or prose.
      const ficha = parseFicha(raw)
      if (!ficha) {
        logger.warn("memoryConsolidationPipeline: invalid ficha JSON, skipping drawer", {
          drawerId: drawer.id,
          rawSnippet: raw.slice(0, 200),
        })
        fichasSkipped++
        return null
      }

      // Defensive size cap.
      const serialized = JSON.stringify(ficha)
      if (serialized.length > maxFichaChars) {
        logger.warn("memoryConsolidationPipeline: ficha too large, truncating", {
          drawerId: drawer.id,
          size: serialized.length,
          cap: maxFichaChars,
        })
        // Truncate arrays, not the whole ficha.
        ficha.key_facts = ficha.key_facts.slice(0, 20)
        ficha.topics = ficha.topics.slice(0, 10)
        ficha.action_items = ficha.action_items.slice(0, 20)
        ficha.person_refs = ficha.person_refs.slice(0, 10)
      }

      return ficha
    },
    sink: async (ficha, chunk) => {
      const drawer = JSON.parse(chunk.text) as DrawerRecord
      const inserted = insertFichaNode(db, drawer, ficha, opts)
      if (inserted) fichasInserted++
      else fichasSkipped++
    },
  })

  return {
    ...result,
    drawersScanned: allDrawers.length,
    fichasInserted,
    fichasSkipped,
  }
}

// --- internal helpers ---

/**
 * List drawers for a profile. Excludes BOOT_/CONF_ system wings.
 * Ordered by rowid ASC for deterministic iteration.
 */
function listDrawersForProfile(db: Database.Database, profileId: string, _rootDir: string): DrawerRecord[] {
  const rows = db
    .prepare(
      `SELECT rowid, id, wing, room, memory_key, content, created_at
       FROM memory_drawers
       WHERE (profile_id = ? OR profile_id IS NULL)
         AND wing NOT LIKE 'BOOT\_%' ESCAPE '\'
         AND wing NOT LIKE 'CONF\_%' ESCAPE '\'
       ORDER BY rowid ASC`,
    )
    .all(profileId) as Array<{
      rowid: number
      id: string
      wing: string
      room: string
      memory_key: string | null
      content: string
      created_at: string
    }>
  return rows.map((r) => ({
    id: r.id,
    rowid: Number(r.rowid),
    wing: r.wing,
    room: r.room,
    memory_key: r.memory_key,
    content: r.content,
    created_at: r.created_at,
  }))
}

/**
 * Parse a ficha from raw LLM output. Tolerant of markdown fences, leading
 * prose, and trailing punctuation. Returns null if the JSON can't be
 * recovered.
 */
function parseFicha(raw: string): FichaRecord | null {
  if (!raw) return null
  // Strip markdown code fences.
  let cleaned = raw
    .replace(/^```(?:json)?/gm, "")
    .replace(/```$/gm, "")
    .trim()
  // Find the first { and last } to handle leading/trailing prose.
  const firstBrace = cleaned.indexOf("{")
  const lastBrace = cleaned.lastIndexOf("}")
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null
  }
  const candidate = cleaned.slice(firstBrace, lastBrace + 1)
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>
    return {
      topics: asStringArray(parsed.topics),
      key_facts: asStringArray(parsed.key_facts),
      action_items: asStringArray(parsed.action_items),
      person_refs: asStringArray(parsed.person_refs),
    }
  } catch {
    return null
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Insert a ficha into palace_nodes. Idempotent via OR IGNORE. */
function insertFichaNode(
  db: Database.Database,
  drawer: DrawerRecord,
  ficha: FichaRecord,
  opts: MemoryConsolidationOptions,
): boolean {
  const now = new Date().toISOString()
  // The natural key: namespace + subject_id. We use the consolidation scope
  // (sessionId + profileId) so a ficha created in a different session
  // for the same drawer doesn't get ignored.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO palace_nodes
        (id, namespace, wing, room, node_key, profile_id, profile_scope,
         subject_type, subject_id, content_type, content, mutable,
         created_at, updated_at, superseded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      `${opts.sessionId}:${drawer.id}`, // id: scope + drawer
      "project_facts",                  // namespace
      "MEMORY_CONSOLIDATION",            // wing
      "fichas",                          // room
      drawer.id,                         // node_key
      opts.profileId,                    // profile_id
      "__global__",                      // profile_scope
      "memory_drawer_ficha",             // subject_type
      drawer.id,                         // subject_id
      "application/json",                // content_type
      JSON.stringify({ ...ficha, sourceContentLength: drawer.content.length }), // content
      0,                                 // mutable: 0 (immutable ficha)
      now,                               // created_at
      now,                               // updated_at
    )
  return result.changes > 0
}
