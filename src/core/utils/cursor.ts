// Durable processing cursor for process-and-flush pipelines.
//
// Supports SQLite (legacy) or JSON file storage when MONOLITO_STORAGE_BACKEND=files.

import type Database from "better-sqlite3"
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { createLogger } from "../logging/logger.ts"
import { isFileStorageBackend } from "../storage/fileStorage.ts"
import { processingCursorsPath } from "../storage/filePaths.ts"

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

export type CursorStorage =
  | { kind: "sqlite"; db: Database.Database }
  | { kind: "files"; rootDir: string }

let _schemaEnsured = false
let _schemaDb: Database.Database | null = null

export function cursorStorageFromRoot(rootDir: string): CursorStorage {
  if (isFileStorageBackend(rootDir)) return { kind: "files", rootDir }
  return { kind: "sqlite", db: null as unknown as Database.Database }
}

/** Ensure the processing_cursors table exists. Idempotent. */
export function bindCursorDb(db: Database.Database): void {
  if (_schemaEnsured && _schemaDb === db) return
  db.exec(CURSOR_SCHEMA_SQL)
  _schemaEnsured = true
  _schemaDb = db
}

function ensureSchema(db: Database.Database): void {
  bindCursorDb(db)
}

function zeroState(streamId: string): CursorState {
  return {
    streamId,
    position: 0,
    lastProcessedAt: null,
    totalProcessed: 0,
    totalErrors: 0,
    meta: {},
  }
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

function readFileCursors(rootDir: string): Record<string, CursorState> {
  const path = processingCursorsPath(rootDir)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, CursorState>
  } catch {
    return {}
  }
}

function writeFileCursors(rootDir: string, data: Record<string, CursorState>) {
  const path = processingCursorsPath(rootDir)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
  renameSync(tmp, path)
}

/** Read the current cursor. Returns zero state if the stream has never been seen. */
export function getCursor(storage: CursorStorage, streamId: string): CursorState {
  if (storage.kind === "files") {
    const all = readFileCursors(storage.rootDir)
    return all[streamId] ?? zeroState(streamId)
  }
  const db = storage.db
  ensureSchema(db)
  const row = db
    .prepare(
      `SELECT stream_id, position, last_processed_at, total_processed, total_errors, meta
       FROM processing_cursors WHERE stream_id = ?`,
    )
    .get(streamId) as Record<string, unknown> | undefined
  if (!row) return zeroState(streamId)
  return rowToState(row)
}

export function advanceCursor(
  storage: CursorStorage,
  streamId: string,
  newPosition: number,
  meta?: Record<string, unknown>,
  now: string = new Date().toISOString(),
): CursorState {
  if (storage.kind === "files") {
    const all = readFileCursors(storage.rootDir)
    const current = all[streamId] ?? zeroState(streamId)
    if (newPosition <= current.position) return current
    const next: CursorState = {
      ...current,
      position: newPosition,
      lastProcessedAt: now,
      meta: meta !== undefined ? meta : current.meta,
    }
    all[streamId] = next
    writeFileCursors(storage.rootDir, all)
    return next
  }

  const db = storage.db
  ensureSchema(db)
  const current = getCursor(storage, streamId)
  if (newPosition <= current.position) return current
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
  return getCursor(storage, streamId)
}

export function incrementCounters(
  storage: CursorStorage,
  streamId: string,
  which: "processed" | "errors",
  now: string = new Date().toISOString(),
): CursorState {
  if (storage.kind === "files") {
    const all = readFileCursors(storage.rootDir)
    const current = all[streamId] ?? zeroState(streamId)
    const next: CursorState = {
      ...current,
      lastProcessedAt: now,
      totalProcessed: which === "processed" ? current.totalProcessed + 1 : current.totalProcessed,
      totalErrors: which === "errors" ? current.totalErrors + 1 : current.totalErrors,
    }
    all[streamId] = next
    writeFileCursors(storage.rootDir, all)
    return next
  }

  const db = storage.db
  ensureSchema(db)
  getCursor(storage, streamId)
  const col = which === "processed" ? "total_processed" : "total_errors"
  db.prepare(
    `UPDATE processing_cursors SET ${col} = ${col} + 1, last_processed_at = ? WHERE stream_id = ?`,
  ).run(now, streamId)
  return getCursor(storage, streamId)
}

export function resetCursor(
  storage: CursorStorage,
  streamId: string,
  now: string = new Date().toISOString(),
): CursorState {
  if (storage.kind === "files") {
    const all = readFileCursors(storage.rootDir)
    all[streamId] = { ...zeroState(streamId), lastProcessedAt: now }
    writeFileCursors(storage.rootDir, all)
    return all[streamId]!
  }

  const db = storage.db
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
  return getCursor(storage, streamId)
}

export function listCursors(storage: CursorStorage): CursorState[] {
  if (storage.kind === "files") {
    return Object.values(readFileCursors(storage.rootDir))
  }
  const db = storage.db
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

/** Back-compat shim: getCursor with raw sqlite db. */
export function getCursorDb(db: Database.Database, streamId: string): CursorState {
  return getCursor({ kind: "sqlite", db }, streamId)
}

export function advanceCursorDb(
  db: Database.Database,
  streamId: string,
  newPosition: number,
  meta?: Record<string, unknown>,
  now?: string,
): CursorState {
  return advanceCursor({ kind: "sqlite", db }, streamId, newPosition, meta, now)
}

export function incrementCountersDb(
  db: Database.Database,
  streamId: string,
  which: "processed" | "errors",
  now?: string,
): CursorState {
  return incrementCounters({ kind: "sqlite", db }, streamId, which, now)
}

export function resetCursorDb(db: Database.Database, streamId: string, now?: string): CursorState {
  return resetCursor({ kind: "sqlite", db }, streamId, now)
}
