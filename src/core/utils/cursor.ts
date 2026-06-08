// Durable processing cursor for process-and-flush pipelines.
//
// Mirrors the pattern of telegram_raw_updates: PK natural + last_processed_at
// + counters + opaque meta JSON. The cursor survives crashes, so a process-
// and-flush pipeline can resume from the last successful chunk instead of
// restarting from zero.
//
// Schema is created lazily on first call (idempotent CREATE TABLE IF NOT EXISTS).
// No external migration runner needed.

import type Database from "better-sqlite3"
import { createLogger } from "../logging/logger.ts"

const logger = createLogger("cursor")

export const CURSOR_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS processing_cursors (
    stream_id TEXT PRIMARY KEY,
    position INTEGER NOT NULL DEFAULT 0,
    last_processed_at TEXT,
    total_processed INTEGER NOT NULL DEFAULT 0,
    total_errors INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_processing_cursors_last
    ON processing_cursors(last_processed_at);
`

export interface CursorState {
  streamId: string
  position: number
  lastProcessedAt: string | null
  totalProcessed: number
  totalErrors: number
  meta: Record<string, unknown>
}

let _schemaEnsured = false
let _schemaDb: Database.Database | null = null

/** Ensure the processing_cursors table exists. Idempotent. */
export function bindCursorDb(db: Database.Database): void {
  if (_schemaEnsured && _schemaDb === db) return
  db.exec(CURSOR_SCHEMA_SQL)
  _schemaEnsured = true
  _schemaDb = db
}

/** Internal: ensure schema once per (db instance). */
function ensureSchema(db: Database.Database): void {
  bindCursorDb(db)
}

function rowToState(row: Record<string, unknown>): CursorState {
  let meta: Record<string, unknown> = {}
  if (typeof row.meta === "string" && row.meta.length > 0) {
    try {
      meta = JSON.parse(row.meta)
    } catch (e) {
      logger.warn("cursor: failed to parse meta JSON, using empty", {
        streamId: row.stream_id,
        errorMessage: (e as Error).message,
      })
    }
  }
  return {
    streamId: row.stream_id as string,
    position: Number(row.position ?? 0),
    lastProcessedAt: (row.last_processed_at as string | null) ?? null,
    totalProcessed: Number(row.total_processed ?? 0),
    totalErrors: Number(row.total_errors ?? 0),
    meta,
  }
}

/** Read the current cursor. Returns zero state if the stream has never been seen. */
export function getCursor(db: Database.Database, streamId: string): CursorState {
  ensureSchema(db)
  const row = db
    .prepare(
      `SELECT stream_id, position, last_processed_at, total_processed, total_errors, meta
       FROM processing_cursors WHERE stream_id = ?`,
    )
    .get(streamId) as Record<string, unknown> | undefined
  if (!row) {
    return {
      streamId,
      position: 0,
      lastProcessedAt: null,
      totalProcessed: 0,
      totalErrors: 0,
      meta: {},
    }
  }
  return rowToState(row)
}

/**
 * Advance the cursor. Upsert: creates the row if missing.
 *
 * Semantics:
 * - `newPosition` MUST be > current position (monotonic). If not, the call is
 *   a no-op and the existing state is returned unchanged.
 * - If `meta` is provided, it REPLACES the stored meta entirely. Pass the
 *   full merged object if you want to preserve prior keys.
 * - `totalProcessed` and `totalErrors` are NOT modified by this call — they
 *   are managed by `incrementCounters` after a successful sink / failed chunk.
 */
export function advanceCursor(
  db: Database.Database,
  streamId: string,
  newPosition: number,
  meta?: Record<string, unknown>,
  now: string = new Date().toISOString(),
): CursorState {
  ensureSchema(db)
  const current = getCursor(db, streamId)
  if (newPosition <= current.position) {
    return current
  }
  const metaJson = meta !== undefined ? JSON.stringify(meta) : current.meta ? JSON.stringify(current.meta) : "{}"
  db.prepare(
    `INSERT INTO processing_cursors
       (stream_id, position, last_processed_at, total_processed, total_errors, meta)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(stream_id) DO UPDATE SET
       position = excluded.position,
       last_processed_at = excluded.last_processed_at,
       meta = excluded.meta`,
  ).run(streamId, newPosition, now, current.totalProcessed, current.totalErrors, metaJson)
  return getCursor(db, streamId)
}

/** Increment total_processed (or total_errors) by 1 for a given stream. */
export function incrementCounters(
  db: Database.Database,
  streamId: string,
  which: "processed" | "errors",
  now: string = new Date().toISOString(),
): CursorState {
  ensureSchema(db)
  // Make sure the row exists before UPDATE.
  getCursor(db, streamId)
  const col = which === "processed" ? "total_processed" : "total_errors"
  db.prepare(
    `UPDATE processing_cursors SET ${col} = ${col} + 1, last_processed_at = ? WHERE stream_id = ?`,
  ).run(now, streamId)
  return getCursor(db, streamId)
}

/** Reset the cursor to position 0 and zero the counters. Keeps the row. */
export function resetCursor(
  db: Database.Database,
  streamId: string,
  now: string = new Date().toISOString(),
): CursorState {
  ensureSchema(db)
  db.prepare(
    `INSERT INTO processing_cursors
       (stream_id, position, last_processed_at, total_processed, total_errors, meta)
     VALUES (?, 0, ?, 0, 0, '{}')
     ON CONFLICT(stream_id) DO UPDATE SET
       position = 0,
       last_processed_at = excluded.last_processed_at,
       total_processed = 0,
       total_errors = 0,
       meta = '{}'`,
  ).run(streamId, now)
  return getCursor(db, streamId)
}

/** List all cursors. Useful for debug/recovery tooling. */
export function listCursors(db: Database.Database): CursorState[] {
  ensureSchema(db)
  const rows = db
    .prepare(
      `SELECT stream_id, position, last_processed_at, total_processed, total_errors, meta
       FROM processing_cursors ORDER BY last_processed_at DESC NULLS LAST`,
    )
    .all() as Array<Record<string, unknown>>
  return rows.map(rowToState)
}

/** For tests: forget the lazy-init flag so a new db instance re-creates schema. */
export function _resetSchemaCacheForTests(): void {
  _schemaEnsured = false
  _schemaDb = null
}
