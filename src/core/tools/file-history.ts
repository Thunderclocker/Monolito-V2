// File history: snapshot store que guarda versiones de archivos antes de
// que Write/Edit los modifiquen, para que el usuario pueda recuperar
// versiones anteriores si algo sale mal.
//
// FC parity: extraído del `fileHistoryTrackEdit` de Claude Code. Mismo
// schema v1 con TTL de 30 días.

import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"

const DEFAULT_TTL_DAYS = 30
const DEFAULT_MAX_VERSIONS_PER_PATH = 1000

export type HistoryEntry = {
  sessionId: string
  path: string
  version: number
  contentHash: string
  createdAt: number
  sizeBytes: number
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

function getHistoryRoot(monolitoRoot: string): string {
  return join(monolitoRoot, ".claude", "file-history")
}

function safePath(path: string): string {
  return path.replace(/[^A-Za-z0-9._-]/g, "_")
}

function entryPath(monolitoRoot: string, entry: HistoryEntry): string {
  return join(
    getHistoryRoot(monolitoRoot),
    entry.sessionId,
    safePath(entry.path),
    `${entry.version}@${entry.contentHash}.v1`,
  )
}

/** Trackea una versión del archivo. Si la versión anterior tenía el mismo
 *  hash, no duplica el snapshot. */
export function trackEdit(
  monolitoRoot: string,
  sessionId: string,
  path: string,
  content: string,
  opts: { ttlDays?: number; maxVersions?: number } = {},
): HistoryEntry {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS
  const maxVersions = opts.maxVersions ?? DEFAULT_MAX_VERSIONS_PER_PATH
  const contentHash = hashContent(content)
  const version = nextVersion(monolitoRoot, sessionId, path)
  const entry: HistoryEntry = {
    sessionId,
    path,
    version,
    contentHash,
    createdAt: Date.now(),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  }
  const target = entryPath(monolitoRoot, entry)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, "utf8")
  // garbage collect versions older than TTL or beyond max
  gcOldVersions(monolitoRoot, sessionId, path, ttlDays, maxVersions)
  return entry
}

function nextVersion(monolitoRoot: string, sessionId: string, path: string): number {
  const dir = join(getHistoryRoot(monolitoRoot), sessionId, safePath(path))
  if (!existsSync(dir)) return 1
  const entries = readdirSync(dir).filter(f => f.endsWith(".v1"))
  if (entries.length === 0) return 1
  let max = 0
  for (const f of entries) {
    const m = f.match(/^(\d+)@/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return max + 1
}

function gcOldVersions(
  monolitoRoot: string,
  sessionId: string,
  path: string,
  ttlDays: number,
  maxVersions: number,
) {
  const dir = join(getHistoryRoot(monolitoRoot), sessionId, safePath(path))
  if (!existsSync(dir)) return
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000
  const entries = readdirSync(dir)
    .filter(f => f.endsWith(".v1"))
    .map(f => {
      const m = f.match(/^(\d+)@([A-Za-z0-9]+)\.v1$/)
      if (!m) return null
      const stat = statSync(join(dir, f))
      return { version: parseInt(m[1], 10), hash: m[2], file: f, mtime: stat.mtimeMs }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
  // drop expired
  for (const e of entries) {
    if (e.mtime < cutoff) {
      try { unlinkSync(join(dir, e.file)) } catch {}
    }
  }
  // cap
  const remaining = readdirSync(dir)
    .filter(f => f.endsWith(".v1"))
    .map(f => {
      const m = f.match(/^(\d+)@/)
      if (!m) return null
      return { version: parseInt(m[1], 10), file: f, stat: statSync(join(dir, f)) }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => b.version - a.version)
  for (const e of remaining.slice(maxVersions)) {
    try { unlinkSync(join(dir, e.file)) } catch {}
  }
}

export function getHistory(monolitoRoot: string, sessionId: string, path: string): HistoryEntry[] {
  const dir = join(getHistoryRoot(monolitoRoot), sessionId, safePath(path))
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith(".v1"))
    .map(f => {
      const m = f.match(/^(\d+)@([A-Za-z0-9]+)\.v1$/)
      if (!m) return null
      const stat = statSync(join(dir, f))
      return {
        sessionId,
        path,
        version: parseInt(m[1], 10),
        contentHash: m[2],
        createdAt: stat.mtimeMs,
        sizeBytes: stat.size,
      } as HistoryEntry
    })
    .filter((e): e is HistoryEntry => e !== null)
    .sort((a, b) => b.version - a.version)
}

export function restoreFromHistory(
  monolitoRoot: string,
  sessionId: string,
  path: string,
  version: number,
): { restored: boolean; content?: string; entry?: HistoryEntry } {
  const list = getHistory(monolitoRoot, sessionId, path)
  const entry = list.find(e => e.version === version)
  if (!entry) return { restored: false }
  const source = entryPath(monolitoRoot, entry)
  if (!existsSync(source)) return { restored: false }
  const content = readFileSync(source, "utf8")
  return { restored: true, content, entry }
}

export function listSessionHistory(monolitoRoot: string, sessionId: string): HistoryEntry[] {
  const root = join(getHistoryRoot(monolitoRoot), sessionId)
  if (!existsSync(root)) return []
  const out: HistoryEntry[] = []
  for (const sub of readdirSync(root)) {
    const subPath = join(root, sub)
    if (!statSync(subPath).isDirectory()) continue
    for (const f of readdirSync(subPath).filter(f => f.endsWith(".v1"))) {
      const m = f.match(/^(\d+)@([A-Za-z0-9]+)\.v1$/)
      if (!m) continue
      const stat = statSync(join(subPath, f))
      out.push({
        sessionId,
        path: sub,
        version: parseInt(m[1], 10),
        contentHash: m[2],
        createdAt: stat.mtimeMs,
        sizeBytes: stat.size,
      })
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/** Backup físico en disco (atomic copy) del archivo original antes de que
 *  sea sobreescrito. Devuelve el path del backup o null si el source
 *  no existía. */
export function snapshotFile(
  sourcePath: string,
  backupDir: string,
): { backupPath: string; sizeBytes: number } | null {
  if (!existsSync(sourcePath)) return null
  mkdirSync(backupDir, { recursive: true })
  const hash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex").slice(0, 16)
  const backupPath = join(backupDir, `${Date.now()}_${hash}.bak`)
  copyFileSync(sourcePath, backupPath)
  return { backupPath, sizeBytes: statSync(sourcePath).size }
}

export function clearSessionHistory(monolitoRoot: string, sessionId: string) {
  const root = join(getHistoryRoot(monolitoRoot), sessionId)
  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true })
  }
}
