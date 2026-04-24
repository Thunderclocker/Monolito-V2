import { join } from "node:path"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"
import { randomUUID } from "node:crypto"
import {
  type AgentEvent,
  type SessionRecord,
  type SessionSummary,
  type SessionWorklogEntry,
  ensureDirs,
  getPaths,
} from "../ipc/protocol.ts"
import { generateEmbedding, isEmbeddingsUnavailableError } from "./embeddings.ts"
import {
  BOOT_WING_ORDER,
  DEFAULT_BOOT_WING_CONTENT,
  isBootWingName,
  type BootWingEntry,
  type BootWingName,
} from "../bootstrap/bootWings.ts"
import {
  CONFIG_WING_ORDER,
  DEFAULT_CONFIG_WING_VALUES,
  type ConfigWingName,
  type ConfigWingValueMap,
} from "../config/configWings.ts"
import { createLogger } from "../logging/logger.ts"

let dbInstance: Database.Database | null = null
let dbPathCache: string | null = null
const logger = createLogger("store")
const BOOTSTRAP_SOURCE_ROOM = "__bootstrap__"
const CONFIG_SOURCE_ROOM = "__config__"
const ACTION_LOG_ROOM = "agent-actions"
const CANONICAL_WING = "CANONICAL"

export type CanonicalMemorySlot =
  | "assistant_name"
  | "user_name"
  | "user_preferred_name"
  | "user_location"
  | "user_timezone"

export type CanonicalMemoryState = Partial<Record<CanonicalMemorySlot, string>>

export type KnowledgeGraphTriple = {
  id: string
  profile_id: string | null
  subject: string
  predicate: string
  object: string
  valid_from: string
  valid_to: string | null
  created_at: string
  is_active: boolean
}

const CANONICAL_SLOT_META: Record<CanonicalMemorySlot, { room: "identity" | "user"; label: string }> = {
  assistant_name: { room: "identity", label: "Assistant name" },
  user_name: { room: "user", label: "User name" },
  user_preferred_name: { room: "user", label: "Preferred user name" },
  user_location: { room: "user", label: "User location" },
  user_timezone: { room: "user", label: "User timezone" },
}

function normalizeCanonicalValue(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function sanitizeCanonicalValue(value: string | null | undefined) {
  if (!value) return null
  const normalized = normalizeCanonicalValue(value)
  if (!normalized) return null
  if (/^(desconocido|opcional|\(por definir\)|por definir)$/i.test(normalized)) return null
  return normalized
}

function extractBootField(content: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = content.match(new RegExp(`(?:^|\\n)\\s*[-*]?\\s*${escaped}:\\s*([^\\n]+)`, "i"))
  return sanitizeCanonicalValue(match?.[1] ?? null)
}

function extractAssistantNameFallback(...sources: string[]) {
  for (const source of sources) {
    const direct = extractBootField(source, "Nombre")
    if (direct) return direct
    for (const pattern of [
      /identidad del asistente:\s*se llama\s*['"`“”]?([^.'"`\n]+?)['"`“”]?(?:[.\n]|$)/i,
      /nombre para el asistente[^.\n]*['"`“”]([^'"`“”\n]+)['"`“”]/i,
      /(?:entonces soy|se llama)\s+\*{0,2}['"`“”]?([^*'"`“”\n]+?)['"`“”]?\*{0,2}(?:[.\n]|$)/i,
    ]) {
      const match = source.match(pattern)
      const value = sanitizeCanonicalValue(match?.[1] ?? null)
      if (value && !/^cristian$/i.test(value)) return value
    }
  }
  return null
}

function extractUserLocationFallback(...sources: string[]) {
  for (const source of sources) {
    const direct = extractBootField(source, "Ubicación")
    if (direct) return direct
    const match = source.match(/vive en\s+([^.\n]+(?:,\s*[^.\n]+){0,3})/i)
    const value = sanitizeCanonicalValue(match?.[1] ?? null)
    if (value) return value
  }
  return null
}

function extractPreferredNameFallback(...sources: string[]) {
  for (const source of sources) {
    const direct = extractBootField(source, "Como prefiere ser llamado")
    if (direct) return direct
    const match = source.match(/prefiere ser llamado\s+([^.\n]+)/i)
    const value = sanitizeCanonicalValue(match?.[1] ?? null)
    if (value) return value
  }
  return null
}

export function getDb(rootDir: string): Database.Database {
  const path = join(getPaths(rootDir).stateDir, "memory.sqlite")
  if (dbInstance && dbPathCache === path) return dbInstance

  if (dbInstance) dbInstance.close()
  ensureDirs(rootDir)

  const db = new Database(path)
  sqliteVec.load(db)
  
  db.pragma(`journal_mode = WAL`);
  db.pragma(`synchronous = NORMAL`);
  db.pragma(`foreign_keys = ON`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      profile_id TEXT DEFAULT 'default',
      title TEXT,
      state TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY(profile_id) REFERENCES profiles(id)
    );
    
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT,
      text TEXT,
      at TEXT,
      is_compacted INTEGER DEFAULT 0,
      room_id TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    
    CREATE TABLE IF NOT EXISTS worklog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      type TEXT,
      summary TEXT,
      at TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      event_data TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memory_drawers (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      wing TEXT NOT NULL,
      room TEXT NOT NULL,
      memory_key TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(profile_id) REFERENCES profiles(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_memory_drawers_wing ON memory_drawers(wing);
    CREATE INDEX IF NOT EXISTS idx_memory_drawers_room ON memory_drawers(room);
    CREATE INDEX IF NOT EXISTS idx_memory_drawers_profile ON memory_drawers(profile_id);
    
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_drawers USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[384]
    );

    CREATE TABLE IF NOT EXISTS background_task_groups (
      job_group_id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      pending_tasks INTEGER NOT NULL DEFAULT 0,
      sealed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bg_groups_session
      ON background_task_groups(parent_session_id);

    CREATE TABLE IF NOT EXISTS knowledge_graph (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(profile_id) REFERENCES profiles(id)
    );

    CREATE INDEX IF NOT EXISTS idx_kg_profile_subject
      ON knowledge_graph(profile_id, subject);
    CREATE INDEX IF NOT EXISTS idx_kg_profile_object
      ON knowledge_graph(profile_id, object);
    CREATE INDEX IF NOT EXISTS idx_kg_profile_active
      ON knowledge_graph(profile_id, valid_to);

    -- Insert default profile if not exists
    INSERT OR IGNORE INTO profiles (id, name, description, created_at)
    VALUES ('default', 'Default Agent', 'El agente Monolito principal por defecto.', CURRENT_TIMESTAMP);
  `)

  // Migration: Add profile_id to sessions if missing (better-sqlite3)
  const sessionInfo = db.prepare(`PRAGMA table_info(sessions)`).all() as any[]
  if (!sessionInfo.find(c => c.name === "profile_id")) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN profile_id TEXT DEFAULT 'default'`)
    } catch (e) {
      if (!String(e).includes("duplicate column")) throw e
    }
  }

  const memoryInfo = db.prepare(`PRAGMA table_info(memory_drawers)`).all() as any[]
  if (!memoryInfo.find(c => c.name === "memory_key")) {
    try {
      db.exec(`ALTER TABLE memory_drawers ADD COLUMN memory_key TEXT`)
    } catch (e) {
      if (!String(e).includes("duplicate column")) throw e
    }
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_drawers_key ON memory_drawers(memory_key)`)

  // Shared memories are represented by a NULL profile_id.
  db.exec(`UPDATE memory_drawers SET profile_id = NULL WHERE wing = 'SHARED'`)

  dbInstance = db
  dbPathCache = path
  return db
}

export function ensureBootWings(rootDir: string, profileId = "default") {
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const countStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM memory_drawers
    WHERE wing = ? AND profile_id = ?
  `)
  const insertStmt = db.prepare(`
    INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const latestStmt = db.prepare(`
    SELECT id, content
    FROM memory_drawers
    WHERE wing = ? AND profile_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `)
  const deleteStmt = db.prepare(`DELETE FROM memory_drawers WHERE id = ?`)
  const deleteVecStmt = db.prepare(`DELETE FROM vec_drawers WHERE id = ?`)

  const legacyBootBootstrapTemplate = "# BOOT_BOOTSTRAP - First Run Ritual\n\nHello. You just came online in a brand new workspace.\n\n## Goal\nStart a short, natural onboarding conversation and learn:\n- Who are you?\n- What should the user call you?\n- What kind of agent are you?\n- What tone or vibe should you have?\n- Who is the user?\n- How should you address them?\n- Any optional notes like timezone, pronouns, or preferences?\n\n## Style\n- Do not interrogate.\n- Ask one short question at a time.\n- Offer 3-5 suggestions when the user is unsure.\n- Keep the exchange warm, concise, and practical.\n\n## Persist what you learn\nOnce details are confirmed, update:\n- BOOT_IDENTITY with your name, creature, vibe, and emoji.\n- BOOT_USER with the user's profile and preferred address.\n- BOOT_SOUL with any durable behavior preferences that came out of onboarding.\n\n## Completion\nWhen onboarding is finished, replace this content with a one-line completion note such as:\nBootstrap completed.\n"

  db.exec("BEGIN TRANSACTION")
  try {
    for (const wing of BOOT_WING_ORDER) {
      const existing = countStmt.get(wing, profileId) as { count: number }
      if (existing.count === 0) {
        insertStmt.run(randomUUID(), profileId, wing, BOOTSTRAP_SOURCE_ROOM, wing, DEFAULT_BOOT_WING_CONTENT[wing], now)
        continue
      }
      if (wing === "BOOT_BOOTSTRAP") {
        const latest = latestStmt.get(wing, profileId) as { id: string; content: string } | undefined
        if (latest && latest.content === legacyBootBootstrapTemplate) {
          deleteVecStmt.run(latest.id)
          deleteStmt.run(latest.id)
          insertStmt.run(randomUUID(), profileId, wing, BOOTSTRAP_SOURCE_ROOM, wing, DEFAULT_BOOT_WING_CONTENT[wing], now)
        }
      }
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

export function ensureConfigWings(rootDir: string) {
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const countStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM memory_drawers
    WHERE wing = ? AND profile_id IS NULL
  `)
  const insertStmt = db.prepare(`
    INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?)
  `)

  db.exec("BEGIN TRANSACTION")
  try {
    for (const wing of CONFIG_WING_ORDER) {
      const existing = countStmt.get(wing) as { count: number }
      if (existing.count > 0) continue
      insertStmt.run(randomUUID(), wing, CONFIG_SOURCE_ROOM, wing, JSON.stringify(DEFAULT_CONFIG_WING_VALUES[wing], null, 2), now)
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

export function readConfigWing<T extends ConfigWingName>(rootDir: string, wing: T): ConfigWingValueMap[T] {
  ensureConfigWings(rootDir)
  const db = getDb(rootDir)
  const row = db.prepare(`
    SELECT content
    FROM memory_drawers
    WHERE wing = ? AND profile_id IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(wing) as { content: string } | undefined
  if (!row?.content) return DEFAULT_CONFIG_WING_VALUES[wing]
  try {
    return JSON.parse(row.content) as ConfigWingValueMap[T]
  } catch {
    return DEFAULT_CONFIG_WING_VALUES[wing]
  }
}

export function writeConfigWing<T extends ConfigWingName>(rootDir: string, wing: T, value: ConfigWingValueMap[T]) {
  ensureConfigWings(rootDir)
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const content = JSON.stringify(value, null, 2)
  const rows = db.prepare(`
    SELECT id, content
    FROM memory_drawers
    WHERE wing = ? AND profile_id IS NULL
    ORDER BY created_at DESC, id DESC
  `).all(wing) as { id: string; content: string }[]
  if ((rows[0]?.content ?? "") === content) {
    return { changed: false, bytes: Buffer.byteLength(content) }
  }

  db.exec("BEGIN TRANSACTION")
  try {
    if (rows.length > 0) {
      db.prepare(`
        UPDATE memory_drawers
        SET content = ?, created_at = ?, room = ?, memory_key = ?
        WHERE id = ?
      `).run(content, now, CONFIG_SOURCE_ROOM, wing, rows[0]!.id)
      const deleteMemory = db.prepare(`DELETE FROM memory_drawers WHERE id = ?`)
      const deleteVec = db.prepare(`DELETE FROM vec_drawers WHERE id = ?`)
      for (const row of rows.slice(1)) {
        deleteVec.run(row.id)
        deleteMemory.run(row.id)
      }
    } else {
      db.prepare(`
        INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?)
      `).run(randomUUID(), wing, CONFIG_SOURCE_ROOM, wing, content, now)
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  return { changed: true, bytes: Buffer.byteLength(content) }
}

export function appendActionLog(rootDir: string, action: string, details?: Record<string, unknown>) {
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const payload = {
    action,
    details: details ?? {},
    at: now,
  }
  db.prepare(`
    INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at)
    VALUES (?, NULL, 'LOG_ACTIONS', ?, ?, ?, ?)
  `).run(randomUUID(), ACTION_LOG_ROOM, "action", JSON.stringify(payload), now)
}

export function readBootWing(rootDir: string, wing: BootWingName, profileId = "default"): string | null {
  ensureBootWings(rootDir, profileId)
  const db = getDb(rootDir)
  const stmt = db.prepare(`
    SELECT content
    FROM memory_drawers
    WHERE wing = ?
      AND (profile_id = ? OR profile_id IS NULL)
    ORDER BY CASE WHEN profile_id = ? THEN 0 ELSE 1 END ASC, created_at DESC, id DESC
    LIMIT 1
  `)
  const row = stmt.get(wing, profileId, profileId) as { content: string } | undefined
  return row?.content ?? null
}

export function writeBootWing(rootDir: string, wing: BootWingName, content: string, profileId = "default") {
  ensureBootWings(rootDir, profileId)
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const rows = db.prepare(`
    SELECT id
    FROM memory_drawers
    WHERE wing = ? AND profile_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(wing, profileId) as { id: string }[]
  const current = rows.length > 0
    ? db.prepare(`SELECT content FROM memory_drawers WHERE id = ?`).get(rows[0]!.id) as { content: string }
    : null
  if ((current?.content ?? "") === content) {
    return { changed: false, bytes: Buffer.byteLength(content) }
  }

  db.exec("BEGIN TRANSACTION")
  try {
    if (rows.length > 0) {
      const deleteMemory = db.prepare(`DELETE FROM memory_drawers WHERE id = ?`)
      const deleteVec = db.prepare(`DELETE FROM vec_drawers WHERE id = ?`)
      for (const row of rows) {
        deleteVec.run(row.id)
        deleteMemory.run(row.id)
      }
    }
    db.prepare(`
      INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), profileId, wing, BOOTSTRAP_SOURCE_ROOM, wing, content, now)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  return { changed: true, bytes: Buffer.byteLength(content) }
}

export function readCanonicalMemory(rootDir: string, profileId = "default"): CanonicalMemoryState {
  const db = getDb(rootDir)
  const rows = db.prepare(`
    SELECT memory_key, content
    FROM memory_drawers
    WHERE wing = ?
      AND (profile_id = ? OR profile_id IS NULL)
      AND memory_key IS NOT NULL
    ORDER BY CASE WHEN profile_id = ? THEN 0 ELSE 1 END ASC, created_at DESC, id DESC
  `).all(CANONICAL_WING, profileId, profileId) as Array<{ memory_key: string; content: string }>

  const state: CanonicalMemoryState = {}
  for (const row of rows) {
    const key = row.memory_key as CanonicalMemorySlot
    if (!(key in CANONICAL_SLOT_META)) continue
    if (state[key]) continue
    const value = sanitizeCanonicalValue(row.content)
    if (value) state[key] = value
  }

  const bootIdentity = readBootWing(rootDir, "BOOT_IDENTITY", profileId) ?? ""
  const bootUser = readBootWing(rootDir, "BOOT_USER", profileId) ?? ""
  const bootMemory = readBootWing(rootDir, "BOOT_MEMORY", profileId) ?? ""

  const assistantName = extractAssistantNameFallback(bootIdentity, bootMemory)
  const userName = extractBootField(bootUser, "Nombre")
  const preferredName = extractPreferredNameFallback(bootUser, bootMemory)
  const userLocation = extractUserLocationFallback(bootUser, bootMemory)
  const userTimezone = extractBootField(bootUser, "Zona horaria")

  if (!state.assistant_name && assistantName) state.assistant_name = assistantName
  if (!state.user_name && userName) state.user_name = userName
  if (!state.user_preferred_name && preferredName) state.user_preferred_name = preferredName
  if (!state.user_location && userLocation) state.user_location = userLocation
  if (!state.user_timezone && userTimezone) state.user_timezone = userTimezone

  return state
}

export function listCanonicalMemoryEntries(rootDir: string, profileId = "default") {
  const state = readCanonicalMemory(rootDir, profileId)
  return (Object.keys(CANONICAL_SLOT_META) as CanonicalMemorySlot[])
    .filter(slot => state[slot])
    .map(slot => ({
      slot,
      room: CANONICAL_SLOT_META[slot].room,
      label: CANONICAL_SLOT_META[slot].label,
      value: state[slot]!,
    }))
}

export async function writeCanonicalMemory(
  rootDir: string,
  slot: CanonicalMemorySlot,
  value: string,
  profileId = "default",
) {
  const normalized = sanitizeCanonicalValue(value)
  if (!normalized) {
    throw new Error(`Canonical memory value for ${slot} must be a non-empty stable string`)
  }
  const meta = CANONICAL_SLOT_META[slot]
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const existingRows = db.prepare(`
    SELECT id, content
    FROM memory_drawers
    WHERE wing = ? AND room = ? AND memory_key = ? AND profile_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(CANONICAL_WING, meta.room, slot, profileId) as Array<{ id: string; content: string }>

  if (sanitizeCanonicalValue(existingRows[0]?.content ?? null) === normalized) {
    return { changed: false, bytes: Buffer.byteLength(normalized), slot, value: normalized }
  }

  let embedding: number[] | null = null
  try {
    embedding = await generateEmbedding(rootDir, normalized)
  } catch (error) {
    logger.warn("Embeddings fallaron, guardando memoria sin vectores: " + (error instanceof Error ? error.message : String(error)))
    embedding = null
  }

  db.exec("BEGIN TRANSACTION")
  try {
    if (existingRows.length > 0) {
      db.prepare(`
        UPDATE memory_drawers
        SET content = ?, created_at = ?, room = ?, memory_key = ?
        WHERE id = ?
      `).run(normalized, now, meta.room, slot, existingRows[0]!.id)
      db.prepare(`DELETE FROM vec_drawers WHERE id = ?`).run(existingRows[0]!.id)
      if (embedding) {
        db.prepare(`INSERT INTO vec_drawers (id, embedding) VALUES (?, ?)`).run(existingRows[0]!.id, embedding)
      }
      const deleteMemory = db.prepare(`DELETE FROM memory_drawers WHERE id = ?`)
      const deleteVec = db.prepare(`DELETE FROM vec_drawers WHERE id = ?`)
      for (const row of existingRows.slice(1)) {
        deleteVec.run(row.id)
        deleteMemory.run(row.id)
      }
    } else {
      const id = randomUUID()
      db.prepare(`
        INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, profileId, CANONICAL_WING, meta.room, slot, normalized, now)
      if (embedding) {
        db.prepare(`INSERT INTO vec_drawers (id, embedding) VALUES (?, ?)`).run(id, embedding)
      }
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  return { changed: true, bytes: Buffer.byteLength(normalized), slot, value: normalized }
}

export function listBootEntries(rootDir: string, profileId = "default", options?: { includeMemory?: boolean; maxCharsPerEntry?: number; maxTotalChars?: number }) {
  ensureBootWings(rootDir, profileId)
  const includeMemory = options?.includeMemory ?? true
  const maxCharsPerEntry = options?.maxCharsPerEntry ?? 20_000
  let remainingChars = options?.maxTotalChars ?? 150_000
  const entries: BootWingEntry[] = []

  for (const wing of BOOT_WING_ORDER) {
    if (!includeMemory && wing === "BOOT_MEMORY") continue
    if (remainingChars <= 0) break
    const content = readBootWing(rootDir, wing, profileId)?.trim() ?? ""
    if (!content) continue
    const maxChars = Math.max(1, Math.min(maxCharsPerEntry, remainingChars))
    const truncated = content.length > maxChars
      ? { content: `${content.slice(0, maxChars).trimEnd()}\n\n[truncated]`, truncated: true }
      : { content, truncated: false }
    entries.push({ wing, content: truncated.content, truncated: truncated.truncated })
    remainingChars -= truncated.content.length
  }

  return entries
}

function truncateSummary(text: string, max = 160) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1).trimEnd()}...`
}

function buildMessageSummary(role: "user" | "assistant" | "system", text: string) {
  const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : "System"
  return `${label}: ${truncateSummary(text)}`
}

export function createSession(rootDir: string, title = "Monolito v2 Session", sessionId?: string, profileId = "default"): SessionRecord {
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const id = sessionId ?? randomUUID()

  const stmtSession = db.prepare(`INSERT INTO sessions (id, profile_id, title, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
  const stmtWorklog = db.prepare(`INSERT INTO worklog (session_id, type, summary, at) VALUES (?, ?, ?, ?)`)
  const summary = `Session created: ${truncateSummary(title, 120)}`
  db.exec("BEGIN TRANSACTION")
  try {
    stmtSession.run(id, profileId, title, "idle", now, now)
    stmtWorklog.run(id, "session", summary, now)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }

  return getSession(rootDir, id)!
}

export function updateSessionProfile(rootDir: string, sessionId: string, profileId: string) {
  const db = getDb(rootDir)
  const stmt = db.prepare(`UPDATE sessions SET profile_id = ?, updated_at = ? WHERE id = ?`)
  stmt.run(profileId, new Date().toISOString(), sessionId)
}

export function saveSession(rootDir: string, session: SessionRecord) {
  // This function is less needed in SQL world, but to maintain the IPC API behavior,
  // we update the metadata.
  const db = getDb(rootDir)
  session.updatedAt = new Date().toISOString()
  const stmt = db.prepare(`UPDATE sessions SET title = ?, state = ?, updated_at = ? WHERE id = ?`)
  stmt.run(session.title, session.state, session.updatedAt, session.id)
}

export function getSession(rootDir: string, sessionId: string): SessionRecord | null {
  const db = getDb(rootDir)
  
  const stmtSession = db.prepare(`SELECT id, profile_id, title, state, created_at, updated_at FROM sessions WHERE id = ?`)
  const row = stmtSession.get(sessionId) as any
  if (!row) return null

  const stmtMsgs = db.prepare(`SELECT role, text, at FROM messages WHERE session_id = ? ORDER BY id ASC`)
  const messages = stmtMsgs.all(sessionId) as any[]

  const stmtLogs = db.prepare(`SELECT type, summary, at FROM worklog WHERE session_id = ? ORDER BY id ASC`)
  const worklogs = stmtLogs.all(sessionId) as any[]

  return {
    id: row.id,
    profileId: row.profile_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state: row.state,
    messages: messages.map(m => ({ at: m.at, role: m.role, text: m.text })),
    worklog: worklogs.map(w => ({ at: w.at, type: w.type, summary: w.summary })),
  } as any
}

export function ensureSession(rootDir: string, sessionId?: string, title?: string) {
  if (sessionId) {
    const existing = getSession(rootDir, sessionId)
    if (existing) return existing
  }
  return createSession(rootDir, title, sessionId)
}

export function listSessions(rootDir: string, profileId?: string): SessionSummary[] {
  const db = getDb(rootDir)
  let sql = `SELECT id, profile_id, title, state, created_at, updated_at FROM sessions`
  const params: any[] = []
  if (profileId) {
    sql += ` WHERE profile_id = ?`
    params.push(profileId)
  }
  sql += ` ORDER BY updated_at DESC`
  const stmt = db.prepare(sql)
  const rows = stmt.all(...params) as any[]
  return rows.map(r => ({
    id: r.id,
    profileId: r.profile_id,
    title: r.title,
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export function listSessionRecords(rootDir: string): SessionRecord[] {
  const summaries = listSessions(rootDir)
  return summaries.map(s => getSession(rootDir, s.id)!)
}

export function appendMessage(rootDir: string, sessionId: string, role: "user" | "assistant" | "system", text: string) {
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  
  db.exec("BEGIN TRANSACTION")
  try {
    const stmtMsg = db.prepare(`INSERT INTO messages (session_id, role, text, at) VALUES (?, ?, ?, ?)`)
    stmtMsg.run(sessionId, role, text, now)

    const stmtWorklog = db.prepare(`INSERT INTO worklog (session_id, type, summary, at) VALUES (?, ?, ?, ?)`)
    stmtWorklog.run(sessionId, "message", buildMessageSummary(role, text), now)

    const stmtUpdate = db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
    stmtUpdate.run(now, sessionId)
    
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

export function appendWorklog(rootDir: string, sessionId: string, entry: Omit<SessionWorklogEntry, "at"> & { at?: string }) {
  const db = getDb(rootDir)
  const at = entry.at ?? new Date().toISOString()
  const summary = truncateSummary(entry.summary, 220)
  
  db.exec("BEGIN TRANSACTION")
  try {
    const stmt = db.prepare(`INSERT INTO worklog (session_id, type, summary, at) VALUES (?, ?, ?, ?)`)
    stmt.run(sessionId, entry.type, summary, at)

    const stmtUpdate = db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
    stmtUpdate.run(at, sessionId)
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

export function resetSession(rootDir: string, sessionId: string, options?: { summary?: string }) {
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const summary = options?.summary ?? "Session reset via /new"
  db.exec("BEGIN TRANSACTION")
  try {
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM worklog WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM events WHERE session_id = ?`).run(sessionId)
    db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(now, sessionId)
    db.prepare(`INSERT INTO worklog (session_id, type, summary, at) VALUES (?, ?, ?, ?)`).run(sessionId, "session", summary, now)
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

export function clearMemoryPalace(rootDir: string, profileId = "default") {
  const db = getDb(rootDir)
  const rows = db.prepare(`
    SELECT id
    FROM memory_drawers
    WHERE profile_id = ?
      AND wing NOT LIKE 'CONF\\_%' ESCAPE '\\'
  `).all(profileId) as { id: string }[]
  const graphRows = db.prepare(`
    SELECT COUNT(*) as count
    FROM knowledge_graph
    WHERE profile_id = ?
  `).get(profileId) as { count: number }

  db.exec("BEGIN TRANSACTION")
  try {
    const deleteVec = db.prepare(`DELETE FROM vec_drawers WHERE id = ?`)
    for (const row of rows) {
      deleteVec.run(row.id)
    }
    db.prepare(`
      DELETE FROM memory_drawers
      WHERE profile_id = ?
        AND wing NOT LIKE 'CONF\\_%' ESCAPE '\\'
    `).run(profileId)
    db.prepare(`DELETE FROM knowledge_graph WHERE profile_id = ?`).run(profileId)
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }

  ensureBootWings(rootDir, profileId)
  return {
    memoryRowsDeleted: rows.length,
    graphRowsDeleted: graphRows.count,
  }
}

export function setSessionState(rootDir: string, sessionId: string, state: SessionRecord["state"]) {
  const db = getDb(rootDir)
  const stmt = db.prepare(`UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?`)
  stmt.run(state, new Date().toISOString(), sessionId)
}

export function recoverRunningSessions(rootDir: string, summary = "Recovered after daemon restart") {
  const db = getDb(rootDir)
  const stmt = db.prepare(`SELECT id FROM sessions WHERE state = 'running'`)
  const rows = stmt.all() as { id: string }[]
  
  const recovered: string[] = []
  const now = new Date().toISOString()
  
  for (const row of rows) {
    db.exec("BEGIN TRANSACTION")
    try {
      const stmtUpdate = db.prepare(`UPDATE sessions SET state = 'idle', updated_at = ? WHERE id = ?`)
      stmtUpdate.run(now, row.id)
      
      const stmtLog = db.prepare(`INSERT INTO worklog (session_id, type, summary, at) VALUES (?, ?, ?, ?)`)
      stmtLog.run(row.id, "note", summary, now)
      
      db.exec("COMMIT")
      recovered.push(row.id)
    } catch {
      db.exec("ROLLBACK")
    }
  }
  return recovered
}

export function tailEvents(rootDir: string, sessionId: string, lines = 40): AgentEvent[] {
  const db = getDb(rootDir)
  const stmt = db.prepare(`SELECT event_data FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
  const rows = stmt.all(sessionId, lines) as { event_data: string }[]
  
  // They come out in DESC order, so reverse them for chronological tail
  return rows.reverse().map(r => JSON.parse(r.event_data))
}

export function appendEvent(rootDir: string, event: AgentEvent) {
  const db = getDb(rootDir)
  const stmt = db.prepare(`INSERT INTO events (session_id, event_data) VALUES (?, ?)`)
  stmt.run(event.sessionId, JSON.stringify(event))
}

// --- Session compaction ---

const DEFAULT_COMPACT_MESSAGE_LIMIT = 40
const COMPACT_PROTECTED_TAIL = 5
const COMPACT_SNIP_THRESHOLD_CHARS = 3_000
const COMPACT_SNIP_TARGET_CHARS = 1_000
const COMPACT_SNIP_SUFFIX = "\n...[snipped by compaction]"

type CompactOptions = {
  maxMessages?: number
}

function buildCompactMarker(count: number, role: "user" | "assistant"): string {
  return `[${count} earlier ${role} message${count > 1 ? "s" : ""} compacted]`
}

export function compactSession(rootDir: string, sessionId: string, options: CompactOptions = {}): { compacted: number; remaining: number } {
  const db = getDb(rootDir)
  const maxMessages = options.maxMessages ?? DEFAULT_COMPACT_MESSAGE_LIMIT
  
  // We need to find how many messages there are.
  const stmtCount = db.prepare(`SELECT count(id) as c FROM messages WHERE session_id = ?`)
  const { c: totalMessages } = stmtCount.get(sessionId) as { c: number }

  const snipCandidates = db.prepare(`
    SELECT id, text
    FROM messages
    WHERE session_id = ?
      AND id NOT IN (
        SELECT id
        FROM messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
      AND length(text) > ?
      AND text NOT LIKE ?
    ORDER BY id ASC
  `).all(
    sessionId,
    sessionId,
    COMPACT_PROTECTED_TAIL,
    COMPACT_SNIP_THRESHOLD_CHARS,
    `%${COMPACT_SNIP_SUFFIX}`,
  ) as Array<{ id: number; text: string }>

  if (snipCandidates.length > 0) {
    const updateSnip = db.prepare(`
      UPDATE messages
      SET text = substr(text, 1, ?) || ?, is_compacted = 1
      WHERE id = ?
    `)

    db.exec("BEGIN TRANSACTION")
    try {
      for (const candidate of snipCandidates) {
        updateSnip.run(COMPACT_SNIP_TARGET_CHARS, COMPACT_SNIP_SUFFIX, candidate.id)
      }
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
    return { compacted: snipCandidates.length, remaining: totalMessages }
  }
  
  if (totalMessages <= maxMessages) {
    return { compacted: 0, remaining: totalMessages }
  }
  
  const toRemoveCount = totalMessages - maxMessages
  
  // Get the ones to remove
  const stmtToCompact = db.prepare(`SELECT id, role, at, text FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?`)
  const removed = stmtToCompact.all(sessionId, toRemoveCount) as any[]
  
  const userCount = removed.filter(m => m.role === "user").length
  const assistantCount = removed.filter(m => m.role === "assistant").length
  const systemCount = removed.filter(m => m.role === "system").length
  
  const firstAt = removed[0].at
  const lastIdRemoved = removed[removed.length - 1].id

  db.exec("BEGIN TRANSACTION")
  try {
    // Delete them
    const stmtDel = db.prepare(`DELETE FROM messages WHERE session_id = ? AND id <= ?`)
    stmtDel.run(sessionId, lastIdRemoved)
    
    // We insert compacted markers so they sit historically. 
    // Wait, if we INSERT they get AUTOINCREMENTed to the end, breaking order!
    // SQLite doesn't let us easily insert at the start of `id`. 
    // Best way: keep the latest `id` of removed, but we want markers to appear BEFORE the kept messages.
    // Let's modify the scheme: we can query by `id` ASC. If we update the last removed to be the marker, and delete the rest?
    // Let's just do an UPDATE on the last few removed rows to turn them into markers, and delete the rest.
    
    const markers: { role: string, text: string }[] = []
    if (systemCount > 0) {
      markers.push({ role: "system", text: `[${systemCount} system message${systemCount > 1 ? "s" : ""} from earlier in session — last updated: ${new Date(removed[0]!.at).toLocaleDateString()}]` })
    }
    if (userCount > 0) markers.push({ role: "assistant", text: buildCompactMarker(userCount, "user") })
    if (assistantCount > 0) markers.push({ role: "assistant", text: buildCompactMarker(assistantCount, "assistant") })
    
    // For each marker, update one of the rows instead of deleting, then delete the rest.
    const toKeepAsMarkers = removed.slice(removed.length - markers.length) // grab last N rows
    const toActualDelete = removed.slice(0, removed.length - markers.length)
    
    if (toActualDelete.length > 0) {
      const delLimit = toActualDelete[toActualDelete.length - 1].id
      const stmtDelReal = db.prepare(`DELETE FROM messages WHERE session_id = ? AND id <= ?`)
      stmtDelReal.run(sessionId, delLimit)
    }
    
    // Update the reserved rows with marker data
    for (let i = 0; i < markers.length; i++) {
      const rowToOverride = toKeepAsMarkers[i]
      const marker = markers[i]
      const stmtUpdateMsg = db.prepare(`UPDATE messages SET role = ?, text = ?, is_compacted = 1 WHERE id = ?`)
      stmtUpdateMsg.run(marker.role, marker.text, rowToOverride.id)
    }

    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
  
  return { compacted: removed.length, remaining: maxMessages + (systemCount>0?1:0) + (userCount>0?1:0) + (assistantCount>0?1:0) }
}

export function getSessionStats(rootDir: string, sessionId: string) {
  const db = getDb(rootDir)
  const session = getSession(rootDir, sessionId)
  if (!session) return null
  
  const totalChars = session.messages.reduce((sum, m) => sum + m.text.length, 0)
  return {
    id: session.id,
    messageCount: session.messages.length,
    totalChars,
    worklogEntries: session.worklog.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    state: session.state,
  }
}

// --- MemPalace Memory Storage ---

export async function fileMemory(rootDir: string, wing: string, room: string, content: string, profileId = "default", key?: string) {
  const db = getDb(rootDir)
  const id = randomUUID()
  const now = new Date().toISOString()
  const rawWing = wing.trim()
  if (rawWing.toUpperCase().startsWith("BOOT_")) {
    throw new Error("BOOT_* wings are reserved for deterministic bootstrap state. Use BootWrite instead.")
  }
  if (rawWing.toUpperCase().startsWith("CONF_")) {
    throw new Error("CONF_* wings are reserved for technical configuration state. Use ConfigWrite/tool_manage_config instead.")
  }
  const normalizedWing = rawWing.length === 0 ? "PRIVATE" : rawWing.toUpperCase() === "SHARED" ? "SHARED" : rawWing
  const normalizedRoom = room.trim() || "general"
  const normalizedKey = key?.trim() || null
  const storedProfileId = normalizedWing.toUpperCase() === "SHARED" ? null : profileId
  let floatArray: Float32Array | null = null
  try {
    floatArray = await generateEmbedding(rootDir, content)
  } catch (error) {
    logger.warn("Embeddings fallaron, guardando memoria sin vectores: " + (error instanceof Error ? error.message : String(error)))
    if (!isEmbeddingsUnavailableError(error)) throw error
  }
  
  db.exec("BEGIN TRANSACTION")
  try {
    const stmt = db.prepare(`INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    stmt.run(id, storedProfileId, normalizedWing, normalizedRoom, normalizedKey, content, now)
    
    // Guardar vector matematico
    if (floatArray) {
      const stmtVec = db.prepare(`INSERT INTO vec_drawers (id, embedding) VALUES (?, ?)`)
      stmtVec.run(id, floatArray)
    }
    
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
  return id
}

export async function recallMemory(rootDir: string, wing?: string, room?: string, query?: string, profileId?: string, key?: string) {
  const db = getDb(rootDir)
  const params: any[] = []
  const conditions: string[] = [
    `m.wing NOT LIKE 'BOOT\\_%' ESCAPE '\\'`,
    `m.wing NOT LIKE 'CONF\\_%' ESCAPE '\\'`,
  ]
  
  if (wing) {
    const normalizedWing = wing.trim().toUpperCase() === "SHARED" ? "SHARED" : wing.trim()
    conditions.push(`m.wing = ?`)
    params.push(normalizedWing)
  }
  if (room) { conditions.push(`m.room = ?`); params.push(room.trim()) }
  if (key) { conditions.push(`m.memory_key = ?`); params.push(key.trim()) }
  
  // Shared memories are stored with NULL profile_id. Unscoped queries only see shared memory.
  if (profileId) {
    conditions.push(`(m.profile_id = ? OR m.profile_id IS NULL)`)
    params.push(profileId)
  } else {
    conditions.push(`m.profile_id IS NULL`)
  }
  
  if (query && query.trim().length > 0) {
    const floatArray = await generateEmbedding(rootDir, query)
    let sql = `
      SELECT m.id, m.profile_id, m.wing, m.room, m.memory_key, m.content, m.created_at, v.distance
      FROM vec_drawers v
      JOIN memory_drawers m ON m.id = v.id
      WHERE v.embedding MATCH ? AND k = 15
    `
    if (conditions.length > 0) {
      sql += ` AND ` + conditions.join(" AND ")
    }
    sql += ` ORDER BY v.distance ASC LIMIT 15`
    
    const stmt = db.prepare(sql)
    return stmt.all(floatArray, ...params) as any[]
  } else {
    // Non-semantic pure recall
    let sql = `SELECT id, profile_id, wing, room, memory_key, content, created_at FROM memory_drawers m`
    if (conditions.length > 0) {
      sql += ` WHERE ` + conditions.join(" AND ")
    }
    sql += ` ORDER BY m.created_at DESC LIMIT 50`
    
    const stmt = db.prepare(sql)
    return stmt.all(...params) as any[]
  }
}

export function listProfiles(rootDir: string) {
  const db = getDb(rootDir)
  const stmt = db.prepare(`SELECT id, name, description, created_at FROM profiles ORDER BY name ASC`)
  return stmt.all() as any[]
}

export function createProfile(rootDir: string, id: string, name: string, description?: string) {
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const stmt = db.prepare(`INSERT INTO profiles (id, name, description, created_at) VALUES (?, ?, ?, ?)`)
  stmt.run(id, name, description ?? null, now)
  return id
}

export function listWings(rootDir: string, profileId?: string): string[] {
  const db = getDb(rootDir)
  let sql = `SELECT DISTINCT wing FROM memory_drawers WHERE wing NOT LIKE 'BOOT\\_%' ESCAPE '\\' AND wing NOT LIKE 'CONF\\_%' ESCAPE '\\'`
  if (profileId) {
    sql += ` AND (profile_id = ? OR profile_id IS NULL)`
  } else {
    sql += ` AND profile_id IS NULL`
  }
  sql += ` ORDER BY wing ASC`
  const stmt = db.prepare(sql)
  return (stmt.all(...(profileId ? [profileId] : [])) as { wing: string }[]).map(r => r.wing)
}

export function listRooms(rootDir: string, wing: string, profileId?: string): string[] {
  const db = getDb(rootDir)
  if (wing.trim().toUpperCase().startsWith("BOOT_")) return []
  if (wing.trim().toUpperCase().startsWith("CONF_")) return []
  let sql = `SELECT DISTINCT room FROM memory_drawers WHERE wing = ?`
  if (profileId) {
    sql += ` AND (profile_id = ? OR profile_id IS NULL)`
  } else {
    sql += ` AND profile_id IS NULL`
  }
  sql += ` ORDER BY room ASC`
  const stmt = db.prepare(sql)
  const params = [wing]
  if (profileId) params.push(profileId)
  return (stmt.all(...params) as { room: string }[]).map(r => r.room)
}

// ---------------------------------------------------------------------------
// Background Task Groups — Fan-out / Fan-in barrier helpers
// ---------------------------------------------------------------------------

export function createBackgroundTaskGroup(rootDir: string, parentSessionId: string): string {
  const db = getDb(rootDir)
  const jobGroupId = randomUUID()
  db.prepare(`
    INSERT INTO background_task_groups (job_group_id, parent_session_id, pending_tasks, sealed, created_at)
    VALUES (?, ?, 1, 0, ?)
  `).run(jobGroupId, parentSessionId, new Date().toISOString())
  return jobGroupId
}

export function incrementBackgroundTaskGroup(rootDir: string, jobGroupId: string): void {
  getDb(rootDir).prepare(`
    UPDATE background_task_groups
    SET pending_tasks = pending_tasks + 1
    WHERE job_group_id = ? AND sealed = 0
  `).run(jobGroupId)
}

export function decrementBackgroundTaskGroup(
  rootDir: string,
  jobGroupId: string,
): { pending: number; sealed: number } | null {
  const row = getDb(rootDir)
    .prepare(`
      UPDATE background_task_groups
      SET pending_tasks = pending_tasks - 1
      WHERE job_group_id = ?
      RETURNING pending_tasks, sealed
    `)
    .get(jobGroupId) as { pending_tasks: number; sealed: number } | undefined
  if (!row) return null
  return { pending: row.pending_tasks, sealed: row.sealed }
}

export function sealBackgroundTaskGroup(
  rootDir: string,
  jobGroupId: string,
): { pending: number } | null {
  const row = getDb(rootDir)
    .prepare(`
      UPDATE background_task_groups
      SET sealed = 1
      WHERE job_group_id = ?
      RETURNING pending_tasks
    `)
    .get(jobGroupId) as { pending_tasks: number } | undefined
  if (!row) return null
  return { pending: row.pending_tasks }
}

export function deleteBackgroundTaskGroup(rootDir: string, jobGroupId: string): void {
  getDb(rootDir)
    .prepare(`DELETE FROM background_task_groups WHERE job_group_id = ?`)
    .run(jobGroupId)
}

export function addGraphTriple(
  rootDir: string,
  profileId: string,
  subject: string,
  predicate: string,
  object: string,
  validFrom: string,
) {
  const db = getDb(rootDir)
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO knowledge_graph (id, profile_id, subject, predicate, object, valid_from, valid_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    id,
    profileId,
    subject.trim(),
    predicate.trim(),
    object.trim(),
    validFrom,
    now,
  )
  return id
}

export function invalidateGraphTriple(
  rootDir: string,
  profileId: string,
  subject: string,
  predicate: string,
  object: string,
  validTo: string,
) {
  const db = getDb(rootDir)
  const result = db.prepare(`
    UPDATE knowledge_graph
    SET valid_to = ?
    WHERE profile_id = ?
      AND subject = ?
      AND predicate = ?
      AND object = ?
      AND valid_to IS NULL
  `).run(
    validTo,
    profileId,
    subject.trim(),
    predicate.trim(),
    object.trim(),
  )
  return { changes: result.changes }
}

export function queryGraphEntity(
  rootDir: string,
  profileId: string,
  entity: string,
): KnowledgeGraphTriple[] {
  const db = getDb(rootDir)
  return db.prepare(`
    SELECT
      id,
      profile_id,
      subject,
      predicate,
      object,
      valid_from,
      valid_to,
      created_at,
      CASE WHEN valid_to IS NULL THEN 1 ELSE 0 END AS is_active
    FROM knowledge_graph
    WHERE profile_id = ?
      AND (subject = ? OR object = ?)
    ORDER BY
      CASE WHEN valid_to IS NULL THEN 0 ELSE 1 END ASC,
      valid_from DESC,
      created_at DESC
  `).all(profileId, entity.trim(), entity.trim()) as KnowledgeGraphTriple[]
}
