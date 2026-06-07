// Per-session read file state — populado por Read, consultado por Edit/Write
// para pre-read enforcement, mtime staleness detection y file_unchanged dedup.
//
// FC parity: mapea la idea de readFileState que mantiene Claude Code por
// sesión, con scope más acotado (LRU + TTL) para evitar leaks.

import { createHash } from "node:crypto"
import { statSync } from "node:fs"
import { join, relative } from "node:path"

const DEFAULT_MAX_ENTRIES = 10_000

type ReadFileStateEntry = {
  content: string
  timestamp: number
  offset: number
  limit?: number
  isPartialView: boolean
  mtime: number
  sizeBytes: number
}

type StateMap = Map<string, ReadFileStateEntry>

const sessionState = new Map<string, StateMap>()

function toWorkspaceRelative(_rootDir: string, path: string): string {
  // Los callers ya pasan paths workspace-relative (e.g. "src/foo.ts" o ".").
  // Devolvemos tal cual para evitar que `relative()` resuelva contra el cwd
  // del proceso en vez de contra rootDir.
  return path.length === 0 ? "." : path
}

function pruneOldest(map: StateMap, max: number) {
  if (map.size <= max) return
  const overflow = map.size - max
  const keysByAge = Array.from(map.entries())
    .sort((a, b) => a[1].timestamp - b[1].timestamp)
    .slice(0, overflow)
  for (const [k] of keysByAge) map.delete(k)
}

export function getReadFileStateForTool(
  sessionId: string,
  rootDir: string,
  path: string,
  maxEntries = DEFAULT_MAX_ENTRIES,
): ReadFileStateEntry | undefined {
  const map = sessionState.get(sessionId)
  if (!map) return undefined
  return map.get(toWorkspaceRelative(rootDir, path))
}

export function setReadFileStateForTool(
  sessionId: string,
  rootDir: string,
  path: string,
  content: string,
  options: { offset?: number; limit?: number } = {},
  maxEntries = DEFAULT_MAX_ENTRIES,
): ReadFileStateEntry {
  let map = sessionState.get(sessionId)
  if (!map) {
    map = new Map()
    sessionState.set(sessionId, map)
  }
  const absPath = join(rootDir, toWorkspaceRelative(rootDir, path))
  let mtime = 0
  let sizeBytes = 0
  try {
    const stat = statSync(absPath)
    mtime = Math.floor(stat.mtimeMs)
    sizeBytes = stat.size
  } catch {
    // file might not exist yet, treat as zero
  }
  const entry: ReadFileStateEntry = {
    content,
    timestamp: Date.now(),
    offset: options.offset ?? 0,
    limit: options.limit,
    isPartialView: options.offset !== undefined && options.offset > 0,
    mtime,
    sizeBytes,
  }
  map.set(toWorkspaceRelative(rootDir, path), entry)
  pruneOldest(map, maxEntries)
  return entry
}

export function clearReadFileStateForTool(sessionId: string, rootDir: string, path: string) {
  const map = sessionState.get(sessionId)
  if (!map) return
  map.delete(toWorkspaceRelative(rootDir, path))
}

export function clearSessionReadFileState(sessionId: string) {
  sessionState.delete(sessionId)
}

/** Returns true if the file on disk has been modified since Read last saw it. */
export function isFileStale(
  sessionId: string,
  rootDir: string,
  path: string,
): { stale: boolean; recordedMtime: number; currentMtime: number } {
  const entry = getReadFileStateForTool(sessionId, rootDir, path)
  if (!entry) return { stale: false, recordedMtime: 0, currentMtime: 0 }
  const absPath = join(rootDir, toWorkspaceRelative(rootDir, path))
  let currentMtime = 0
  try {
    currentMtime = Math.floor(statSync(absPath).mtimeMs)
  } catch {
    return { stale: true, recordedMtime: entry.mtime, currentMtime: 0 }
  }
  return { stale: currentMtime > entry.mtime, recordedMtime: entry.mtime, currentMtime }
}

/** Hash-based dedup helper: same content as before → return stub. */
export function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

export type { ReadFileStateEntry }
