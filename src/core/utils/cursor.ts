// Durable processing cursor for process-and-flush pipelines (JSON file storage).

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { createLogger } from "../logging/logger.ts"
import { processingCursorsPath } from "../storage/filePaths.ts"

const logger = createLogger("cursor")

export interface CursorState {
  streamId: string
  position: number
  lastProcessedAt: string | null
  totalProcessed: number
  totalErrors: number
  meta: Record<string, unknown>
}

export type CursorStorage = { kind: "files"; rootDir: string }

export function cursorStorageFromRoot(rootDir: string): CursorStorage {
  return { kind: "files", rootDir }
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

export function getCursor(storage: CursorStorage, streamId: string): CursorState {
  const all = readFileCursors(storage.rootDir)
  return all[streamId] ?? zeroState(streamId)
}

export function advanceCursor(
  storage: CursorStorage,
  streamId: string,
  newPosition: number,
  meta?: Record<string, unknown>,
  now: string = new Date().toISOString(),
): CursorState {
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

export function incrementCounters(
  storage: CursorStorage,
  streamId: string,
  which: "processed" | "errors",
  now: string = new Date().toISOString(),
): CursorState {
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

export function resetCursor(
  storage: CursorStorage,
  streamId: string,
  now: string = new Date().toISOString(),
): CursorState {
  const all = readFileCursors(storage.rootDir)
  all[streamId] = { ...zeroState(streamId), lastProcessedAt: now }
  writeFileCursors(storage.rootDir, all)
  return all[streamId]!
}

export function listCursors(storage: CursorStorage): CursorState[] {
  const all = Object.values(readFileCursors(storage.rootDir))
  return all.sort((a, b) => {
    const aTime = a.lastProcessedAt ?? ""
    const bTime = b.lastProcessedAt ?? ""
    if (aTime === bTime) return 0
    if (!aTime) return 1
    if (!bTime) return -1
    return bTime.localeCompare(aTime)
  })
}

/** For tests: no-op (file storage has no lazy schema cache). */
export function _resetSchemaCacheForTests(): void {}
