import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"
import { randomUUID, createHash } from "node:crypto"
import {
  type AgentEvent,
  type SessionRecord,
  type SessionSummary,
  type SessionWorklogEntry,
  ensureDirs,
  getPaths,
} from "../ipc/protocol.ts"
import { bindSemanticSearchDb, generateEmbedding, isEmbeddingsUnavailableError } from "./embeddings.ts"
import {
  isMultiChunkEmbeddingsEnabled,
  embedChunked,
  insertChunkEmbeddings,
  recallMultiChunk,
} from "./multiChunkEmbeddings.ts"
import {
  BOOT_WING_ORDER,
  DEFAULT_BOOT_WING_CONTENT,
  type BootWingEntry,
} from "../bootstrap/bootWings.ts"
import {
  CONFIG_WING_ORDER,
  DEFAULT_CONFIG_WING_VALUES,
  type ConfigWingName,
  type ConfigWingValueMap,
} from "../config/configWings.ts"
import { createLogger } from "../logging/logger.ts"
import { PALACE_NAMESPACE, PALACE_SCHEMA_SQL, VECTOR_SCHEMA_SQL, type PalaceContentType, type PalaceNamespace } from "../db/schema.ts"

let dbInstance: Database.Database | null = null
let dbPathCache: string | null = null
const logger = createLogger("store")
const BOOTSTRAP_SOURCE_ROOM = "__bootstrap__"
const CONFIG_SOURCE_ROOM = "__config__"
const ACTION_LOG_ROOM = "agent-actions"
const GLOBAL_PROFILE_SCOPE = "__global__"
const WORKER_SESSION_PREFIXES = ["agent-"] as const

export function isMainSession(sessionId: string): boolean {
  return !WORKER_SESSION_PREFIXES.some(prefix => sessionId.startsWith(prefix))
}

/**
 * True when the process is clearly running unit/integration tests, not the
 * production daemon. Used to gate the runtime-DB safety guard in `getDb`.
 * Production runs the daemon via systemd (MONOLITO_MODE=production) and
 * never has NODE_ENV=test or MONOLITO_TEST_GUARD set.
 */
function isTestContext(): boolean {
  if (process.env.NODE_ENV === "test") return true
  if (process.env.MONOLITO_TEST_GUARD === "1") return true
  // The Node test runner sets NODE_TEST_CONTEXT to a non-empty string in
  // any worker that is currently running a test. This is the most reliable
  // signal even if a test file forgets to set NODE_ENV=test.
  if (typeof process.env.NODE_TEST_CONTEXT === "string" && process.env.NODE_TEST_CONTEXT.length > 0) return true
  return false
}

/**
 * True when the path being opened is a runtime install DB and we are in a
 * test context. Catches the class of bug where a test imports store.ts
 * without isolating MONOLITO_ROOT to a tempdir, and would otherwise
 * overwrite the user's live config (CONF_CHANNELS, CONF_MODELS, etc.).
 *
 * Bypass: set MONOLITO_DB_GUARD=0 in the test if you have a legitimate
 * reason to write to the runtime DB from a test (e.g. golden-file replay).
 */
function shouldRefuseRuntimeDbAccess(dbPath: string): boolean {
  if (!isTestContext()) return false
  if (process.env.MONOLITO_DB_GUARD === "0") return false
  // The runtime DB lives at `${MONOLITO_ROOT}/memory/memory.sqlite`. The
  // install pin in normal setups resolves MONOLITO_ROOT to
  // `${HOME}/.monolito`, so the canonical "live" path is
  // `${HOME}/.monolito/memory/memory.sqlite`. We refuse ANY path that ends
  // in `/memory/memory.sqlite` and is NOT under os.tmpdir().
  if (!dbPath.endsWith("/memory/memory.sqlite")) return false
  if (dbPath.startsWith(tmpdir())) return false
  return true
}

/**
 * Exported for unit testing only. Production code calls `getDb()` and
 * gets the guard applied transparently. Tests in
 * `test_runtime_db_guard.test.ts` import this directly to verify the
 * decision logic without depending on import-time module caching of
 * MONOLITO_ROOT.
 */
export function _runtimeDbGuardForTesting(dbPath: string): boolean {
  return shouldRefuseRuntimeDbAccess(dbPath)
}

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

export type VectorMemoryStatus = {
  extensionLoaded: boolean
  vecMessagesCount: number
  vecDrawersCount: number
}

function palaceProfileScope(profileId: string | null | undefined) {
  return profileId ?? GLOBAL_PROFILE_SCOPE
}

function ensurePalaceSchema(db: Database.Database) {
  db.exec(PALACE_SCHEMA_SQL)
}

function ensureVectorSchema(db: Database.Database) {
  db.exec(`
    DROP TRIGGER IF EXISTS fts_drawers_ai;
    DROP TRIGGER IF EXISTS fts_drawers_ad;
    DROP TRIGGER IF EXISTS fts_drawers_au;
    DROP TABLE IF EXISTS fts_drawers;
  `)

  const vectorTables = db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE name IN ('vec_drawers', 'vec_messages')
  `).all() as Array<{ name: string; sql: string | null }>
  const hasLegacyVectorTable = vectorTables.some(row => 
    !row.sql?.includes("float[1024]") ||
    (row.name === "vec_drawers" && row.sql?.includes("id TEXT"))
  )

  let isVectorDbCorrupt = false
  try {
    if (vectorTables.length > 0) {
      db.prepare("SELECT id FROM vec_drawers LIMIT 1").all()
      db.prepare("SELECT id FROM vec_messages LIMIT 1").all()
    }
  } catch (error) {
    logger.warn(`Vector tables integrity check failed (will auto-recreate): ${error}`)
    isVectorDbCorrupt = true
  }

  if (hasLegacyVectorTable || isVectorDbCorrupt) {
    db.exec(`
      DROP TABLE IF EXISTS vec_drawers;
      DROP TABLE IF EXISTS vec_messages;
    `)
  }
  db.exec(VECTOR_SCHEMA_SQL)
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      provider TEXT,
      model TEXT,
      hash TEXT,
      embedding TEXT,
      dims INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (provider, model, hash)
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON embedding_cache(updated_at);
  `)

  // Multi-chunk embeddings metadata. Lives in a regular table because:
  //   1. vec0 only allows single-column INTEGER PRIMARY KEY.
  //   2. CREATE INDEX on virtual tables is not allowed in SQLite.
  // The (drawer_rowid, chunk_index) → chunk_id mapping is here, and the
  // uniqueness invariant is enforced by idx_drawer_chunk_meta_unique.
  // The actual float vector lives in vec_drawer_chunks keyed by chunk_id.
  // See db/migrations/20260608_vec_drawer_chunks.sql.
  db.exec(`
    CREATE TABLE IF NOT EXISTS drawer_chunk_meta (
      chunk_id INTEGER PRIMARY KEY,
      drawer_rowid INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_drawer_chunk_meta_unique
      ON drawer_chunk_meta(drawer_rowid, chunk_index);
    CREATE INDEX IF NOT EXISTS idx_drawer_chunk_meta_by_drawer
      ON drawer_chunk_meta(drawer_rowid);
  `)
}

function readLatestPalaceContent(
  db: Database.Database,
  options: {
    namespace: PalaceNamespace
    wing: string
    room: string
    nodeKey: string
    profileId?: string | null
    includeGlobalFallback?: boolean
  },
) {
  const profileScope = palaceProfileScope(options.profileId)
  const rows = options.includeGlobalFallback
    ? db.prepare(`
      SELECT content
      FROM palace_nodes
      WHERE namespace = ?
        AND wing = ?
        AND room = ?
        AND node_key = ?
        AND superseded_at IS NULL
        AND profile_scope IN (?, ?)
      ORDER BY CASE WHEN profile_scope = ? THEN 0 ELSE 1 END ASC, updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).all(options.namespace, options.wing, options.room, options.nodeKey, profileScope, GLOBAL_PROFILE_SCOPE, profileScope) as { content: string }[]
    : db.prepare(`
      SELECT content
      FROM palace_nodes
      WHERE namespace = ?
        AND wing = ?
        AND room = ?
        AND node_key = ?
        AND profile_scope = ?
        AND superseded_at IS NULL
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).all(options.namespace, options.wing, options.room, options.nodeKey, profileScope) as { content: string }[]
  return rows[0]?.content ?? null
}

export function upsertMutablePalaceNode(
  db: Database.Database,
  options: {
    namespace: PalaceNamespace
    wing: string
    room: string
    nodeKey: string
    profileId?: string | null
    subjectType?: string | null
    subjectId?: string | null
    contentType: PalaceContentType
    content: string
    now: string
  },
) {
  const profileId = options.profileId ?? null
  const profileScope = palaceProfileScope(profileId)
  const existing = db.prepare(`
    SELECT id, content
    FROM palace_nodes
    WHERE namespace = ?
      AND wing = ?
      AND room = ?
      AND node_key = ?
      AND profile_scope = ?
      AND mutable = 1
      AND superseded_at IS NULL
    ORDER BY updated_at DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(options.namespace, options.wing, options.room, options.nodeKey, profileScope) as { id: string; content: string } | undefined

  if (existing) {
    if (existing.content === options.content) return { changed: false, id: existing.id }
    db.prepare(`
      UPDATE palace_nodes
      SET content = ?,
          content_type = ?,
          updated_at = ?,
          subject_type = ?,
          subject_id = ?
      WHERE id = ?
    `).run(options.content, options.contentType, options.now, options.subjectType ?? null, options.subjectId ?? null, existing.id)
    return { changed: true, id: existing.id }
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO palace_nodes (
      id, namespace, wing, room, node_key, profile_id, profile_scope,
      subject_type, subject_id, content_type, content, mutable, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    options.namespace,
    options.wing,
    options.room,
    options.nodeKey,
    profileId,
    profileScope,
    options.subjectType ?? null,
    options.subjectId ?? null,
    options.contentType,
    options.content,
    options.now,
    options.now,
  )
  return { changed: true, id }
}

function appendPalaceNode(
  db: Database.Database,
  options: {
    namespace: PalaceNamespace
    wing: string
    room: string
    nodeKey?: string | null
    profileId?: string | null
    subjectType?: string | null
    subjectId?: string | null
    contentType: PalaceContentType
    content: string
    now: string
  },
) {
  const id = randomUUID()
  const profileId = options.profileId ?? null
  db.prepare(`
    INSERT INTO palace_nodes (
      id, namespace, wing, room, node_key, profile_id, profile_scope,
      subject_type, subject_id, content_type, content, mutable, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id,
    options.namespace,
    options.wing,
    options.room,
    options.nodeKey ?? null,
    profileId,
    palaceProfileScope(profileId),
    options.subjectType ?? null,
    options.subjectId ?? null,
    options.contentType,
    options.content,
    options.now,
    options.now,
  )
  return id
}

export function writeSessionSource(
  rootDir: string,
  sessionId: string,
  sourceKey: string,
  content: string,
  profileId: string = "default",
) {
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  upsertMutablePalaceNode(db, {
    namespace: PALACE_NAMESPACE.chatHistory,
    wing: "websearch_history",
    room: sessionId,
    nodeKey: sourceKey,
    profileId,
    contentType: "text/plain",
    content,
    now,
  })
}

export function readSessionSources(
  rootDir: string,
  sessionId: string,
  profileId: string = "default",
): Array<{ key: string; content: string }> {
  const db = getDb(rootDir)
  const profileScope = palaceProfileScope(profileId)
  return db
    .prepare(
      `
    SELECT node_key as key, content
    FROM palace_nodes
    WHERE namespace = ?
      AND wing = ?
      AND room = ?
      AND profile_scope = ?
      AND superseded_at IS NULL
    ORDER BY updated_at DESC, created_at DESC
  `,
    )
    .all(PALACE_NAMESPACE.chatHistory, "websearch_history", sessionId, profileScope) as Array<{ key: string; content: string }>
}

export interface SessionTask {
  id: string
  content: string
  /**
   * Present-continuous form of the task (e.g. "Running tests" for
   * content "Run tests"). Optional for backward compatibility with tasks
   * created before the field was added. When present, the TUI renders
   * the activeForm for the in_progress task; when absent, the content is
   * used as-is.
   */
  activeForm?: string
  status: "pending" | "in_progress" | "completed"
  createdAt: string
  updatedAt?: string
  sessionId?: string
}

export function writeSessionTask(
  rootDir: string,
  sessionId: string,
  taskId: string,
  task: SessionTask,
  profileId: string = "default",
) {
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  upsertMutablePalaceNode(db, {
    namespace: PALACE_NAMESPACE.chatHistory,
    wing: "active_tasks",
    room: sessionId,
    nodeKey: taskId,
    profileId,
    contentType: "application/json",
    content: JSON.stringify(task),
    now,
  })
}

export function listSessionTasks(
  rootDir: string,
  sessionId: string,
  profileId: string = "default",
): SessionTask[] {
  const db = getDb(rootDir)
  const profileScope = palaceProfileScope(profileId)
  const rows = db
    .prepare(
      `
    SELECT node_key as id, content
    FROM palace_nodes
    WHERE namespace = ?
      AND wing = ?
      AND room = ?
      AND profile_scope = ?
      AND superseded_at IS NULL
    ORDER BY created_at ASC, id ASC
  `,
    )
    .all(PALACE_NAMESPACE.chatHistory, "active_tasks", sessionId, profileScope) as Array<{ id: string; content: string }>

  const tasks: SessionTask[] = []
  for (const row of rows) {
    try {
      tasks.push(JSON.parse(row.content))
    } catch {}
  }
  return tasks
}

export function deleteSessionTask(
  rootDir: string,
  sessionId: string,
  taskId: string,
  profileId: string = "default",
) {
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const profileScope = palaceProfileScope(profileId)
  db.prepare(
    `
    UPDATE palace_nodes
    SET superseded_at = ?
    WHERE namespace = ?
      AND wing = ?
      AND room = ?
      AND node_key = ?
      AND profile_scope = ?
      AND superseded_at IS NULL
  `,
  ).run(now, PALACE_NAMESPACE.chatHistory, "active_tasks", sessionId, taskId, profileScope)
}

function ensureKernelSeededDb(db: Database.Database, _profileId = "default") {
  ensurePalaceSchema(db)
  const now = new Date().toISOString()
  // Boot wings are seeded ONLY for the "default" profile.
  // Other profiles fall back to default via readLatestPalaceContent's includeGlobalFallback.
  const bootProfileScope = palaceProfileScope("default")
  const existingStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM palace_nodes
    WHERE namespace = ?
      AND profile_scope = ?
      AND wing = ?
      AND node_key = ?
      AND superseded_at IS NULL
  `)

  db.exec("BEGIN TRANSACTION")
  try {
    for (const wing of BOOT_WING_ORDER) {
      const existing = existingStmt.get(PALACE_NAMESPACE.boot, bootProfileScope, wing, wing) as { count: number }
      if (existing.count === 0) {
        upsertMutablePalaceNode(db, {
          namespace: PALACE_NAMESPACE.boot,
          wing,
          room: BOOTSTRAP_SOURCE_ROOM,
          nodeKey: wing,
          profileId: "default",
          subjectType: "boot_wing",
          subjectId: wing,
          contentType: "text/markdown",
          content: DEFAULT_BOOT_WING_CONTENT[wing],
          now,
        })
      }
    }
    for (const wing of CONFIG_WING_ORDER) {
      const existing = existingStmt.get(PALACE_NAMESPACE.config, GLOBAL_PROFILE_SCOPE, wing, wing) as { count: number }
      if (existing.count === 0) {
        upsertMutablePalaceNode(db, {
          namespace: PALACE_NAMESPACE.config,
          wing,
          room: CONFIG_SOURCE_ROOM,
          nodeKey: wing,
          profileId: null,
          subjectType: "config_wing",
          subjectId: wing,
          contentType: "application/json",
          content: JSON.stringify(DEFAULT_CONFIG_WING_VALUES[wing], null, 2),
          now,
        })
      }
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

function hardCrashKernel(error: unknown): never {
  logger.error("FATAL: SQLite kernel failed during startup. Monolito cannot boot without the Palace.", error)
  process.exit(1)
}

export function getDb(rootDir: string): Database.Database {
  const path = join(getPaths(rootDir).stateDir, "memory.sqlite")
  if (dbInstance && dbPathCache === path) return dbInstance

  // Defense-in-depth: refuse to open the runtime DB from a non-production
  // context. The 09-jun-2026 incident — test runs in `~/.monolito/app`
  // overwrote CONF_CHANNELS.telegram.token with the placeholder "abc"
  // because `getPaths()` resolves via `MONOLITO_ROOT` and the install pin
  // pointed at the live data dir. A test that forgets to set MONOLITO_ROOT
  // to a tempdir (or runs against the deploy dir directly) would corrupt
  // the user's config. This guard catches that class of bug at the single
  // entry point used by all DB writes.
  if (shouldRefuseRuntimeDbAccess(path)) {
    throw new Error(
      `Refusing to open runtime DB at ${path} from a non-production context. ` +
        `This looks like a test run that was not isolated to a tempdir. ` +
        `Set MONOLITO_ROOT to a tempdir (process.env.MONOLITO_ROOT = mkdtempSync(...)) ` +
        `before importing this module, or unset MONOLITO_TEST_GUARD=1 / NODE_ENV=test.`
    )
  }

  if (dbInstance) dbInstance.close()
  ensureDirs(rootDir)

  let db: Database.Database
  try {
    db = new Database(path)
    sqliteVec.load(db)
    bindSemanticSearchDb(db)
  
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
      voice_mode INTEGER DEFAULT 0,
      FOREIGN KEY(profile_id) REFERENCES profiles(id)
    );
    
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT,
      text TEXT,
      thinking TEXT,
      at TEXT,
      is_compacted INTEGER DEFAULT 0,
      room_id TEXT,
      hidden_from_user INTEGER DEFAULT 0,
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
    

    -- telegram_raw_updates: durable queue for incoming Telegram updates.
    -- Every update the daemon receives is persisted here BEFORE the
    -- channel manager processes it. If the daemon crashes mid-process,
    -- the updates are still in this table; on the next startup, the
    -- poller re-fetches them (or this table is replayed). This is the
    -- mechanism that keeps Telegram delivery from being lost across
    -- daemon crashes — the most recent successful offset is committed
    -- AFTER the processing, so a crash means Telegram will re-deliver
    -- the same updates (idempotent on update_id).
    CREATE TABLE IF NOT EXISTS telegram_raw_updates (
      update_id INTEGER PRIMARY KEY,
      chat_id INTEGER,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      raw_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_raw_chat
      ON telegram_raw_updates(chat_id);
    CREATE INDEX IF NOT EXISTS idx_telegram_raw_unprocessed
      ON telegram_raw_updates(processed_at) WHERE processed_at IS NULL;

    -- telegram_sent_photos: durable log of every photo Monolito sent.
    -- Populated by TelegramSendPhoto on every successful delivery.
    -- Read by TelegramGetRecentPhotos to support post-send verification
    -- ("verifica la última foto que te mandé"). The file_id is the key
    -- that VisionAnalyze can re-download from Telegram servers.
    -- See db/migrations/20260606_telegram_sent_photos.sql for the
    -- original schema declaration.
    CREATE TABLE IF NOT EXISTS telegram_sent_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      file_id TEXT,
      local_path TEXT NOT NULL,
      caption TEXT,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_sent_photos_chat_time
      ON telegram_sent_photos(chat_id, sent_at DESC);

    -- telegram_sent_audios: durable log of every voice/audio Monolito
    -- sent. Mirrors telegram_sent_photos. The fast dedupe path uses a
    -- JSON file maintained by markAudioAsSent/isAudioAlreadySent in
    -- tools/internal.ts; this table is the audit log so the model can
    -- query recent sends with a future TelegramGetRecentAudios tool.
    -- See db/migrations/20260610_telegram_sent_audios.sql.
    CREATE TABLE IF NOT EXISTS telegram_sent_audios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      file_id TEXT,
      kind TEXT NOT NULL DEFAULT 'voice',
      local_path TEXT NOT NULL,
      duration_seconds INTEGER,
      file_size_bytes INTEGER,
      caption TEXT,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_sent_audios_chat_time
      ON telegram_sent_audios(chat_id, sent_at DESC);

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
    ensureVectorSchema(db)
    ensurePalaceSchema(db)

    // Migration: Add profile_id to sessions if missing (better-sqlite3)
    const sessionInfo = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string; type: string; dflt_value: unknown; pk: number }>
    if (!sessionInfo.find(c => c.name === "profile_id")) {
      try {
        db.exec(`ALTER TABLE sessions ADD COLUMN profile_id TEXT DEFAULT 'default'`)
      } catch (e) {
        if (!String(e).includes("duplicate column")) throw e
      }
    }

    // Migration: Add voice_mode to sessions if missing (2026-06-10).
    // Stores whether voice mode (strict audio-only responses) is active.
    if (!sessionInfo.find(c => c.name === "voice_mode")) {
      try {
        db.exec(`ALTER TABLE sessions ADD COLUMN voice_mode INTEGER DEFAULT 0`)
      } catch (e) {
        if (!String(e).includes("duplicate column")) throw e
      }
    }

    // Migration: Add hidden_from_user to messages if missing.
    // See runtime.ts:2657 — the Top-level Ralph Gate injects a feedback
    // prompt into the session via appendMessage so the model re-attempts.
    // That message is internal orchestration (sub-agent talking to the
    // orchestrator), not user-facing output. Marking it hidden keeps it
    // in the DB for audit/replay but excludes it from the transcript the
    // CLI renders to the user. See src/apps/cli/tui/renderer.ts.
    const messageInfo = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string; type: string; dflt_value: unknown; pk: number }>
    if (!messageInfo.find(c => c.name === "hidden_from_user")) {
      try {
        db.exec(`ALTER TABLE messages ADD COLUMN hidden_from_user INTEGER DEFAULT 0`)
      } catch (e) {
        if (!String(e).includes("duplicate column")) throw e
      }
    }
    if (!messageInfo.find(c => c.name === "thinking")) {
      try {
        db.exec(`ALTER TABLE messages ADD COLUMN thinking TEXT`)
      } catch (e) {
        if (!String(e).includes("duplicate column")) throw e
      }
    }

    const memoryInfo = db.prepare(`PRAGMA table_info(memory_drawers)`).all() as Array<{ name: string; type: string; dflt_value: unknown; pk: number }>
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
    ensureKernelSeededDb(db, "default")
  } catch (error) {
    try {
      db!?.close()
    } catch {}
    hardCrashKernel(error)
  }

  dbInstance = db
  dbPathCache = path
  return db
}

export async function getVectorMemoryStatus(): Promise<VectorMemoryStatus> {
  if (!dbInstance) {
    return {
      extensionLoaded: false,
      vecMessagesCount: 0,
      vecDrawersCount: 0,
    }
  }

  try {
    const vecMessages = dbInstance.prepare(`SELECT count(*) as c FROM vec_messages`).get() as { c: number | bigint }
    const vecDrawers = dbInstance.prepare(`SELECT count(*) as c FROM vec_drawers`).get() as { c: number | bigint }
    return {
      extensionLoaded: true,
      vecMessagesCount: Number(vecMessages.c),
      vecDrawersCount: Number(vecDrawers.c),
    }
  } catch {
    return {
      extensionLoaded: false,
      vecMessagesCount: 0,
      vecDrawersCount: 0,
    }
  }
}

export function closeMemoryDb() {
  if (!dbInstance) return
  try {
    dbInstance.close()
  } finally {
    dbInstance = null
    dbPathCache = null
  }
}

export function ensureKernelSeeded(rootDir: string, profileId = "default") {
  const db = getDb(rootDir)
  try {
    ensureKernelSeededDb(db, profileId)
  } catch (error) {
    hardCrashKernel(error)
  }
}

export function ensureBootWings(rootDir: string, _profileId = "default") {
  const db = getDb(rootDir)
  // Always seed under "default" — other profiles use global fallback
  ensureKernelSeededDb(db, "default")
}

export function ensureConfigWings(rootDir: string) {
  const db = getDb(rootDir)
  ensureKernelSeededDb(db, "default")
}

export function reconcileSystemWings(db: Database.Database, rootDir: string) {
  const now = new Date().toISOString()
  const embeddingsContent = JSON.stringify({
    provider: "ollama",
    model: "bge-m3",
    baseUrl: "http://127.0.0.1:11434",
    dimensions: 1024,
    enabled: true,
  }, null, 2)

  const existing = db.prepare(`
    SELECT content
    FROM palace_nodes
    WHERE namespace = ?
      AND wing = ?
      AND room = ?
      AND node_key = ?
      AND superseded_at IS NULL
  `).get(PALACE_NAMESPACE.config, "CONF_EMBEDDINGS", CONFIG_SOURCE_ROOM, "ollama") as { content: string } | undefined

  if (existing) {
    try {
      const parsed = JSON.parse(existing.content)
      if (parsed.provider && parsed.model) return
    } catch {}
    db.prepare(`
      UPDATE palace_nodes
      SET content = ?, updated_at = ?, superseded_at = ?
      WHERE namespace = ? AND wing = ? AND room = ? AND node_key = ? AND superseded_at IS NULL
    `).run(existing.content, now, now, PALACE_NAMESPACE.config, "CONF_EMBEDDINGS", CONFIG_SOURCE_ROOM, "ollama")
  }

  upsertMutablePalaceNode(db, {
    namespace: PALACE_NAMESPACE.config,
    wing: "CONF_EMBEDDINGS",
    room: CONFIG_SOURCE_ROOM,
    nodeKey: "ollama",
    profileId: null,
    subjectType: "system_capability",
    subjectId: "embeddings",
    contentType: "application/json",
    content: embeddingsContent,
    now,
  })
}

export function readConfigWing<T extends ConfigWingName>(rootDir: string, wing: T): ConfigWingValueMap[T] {
  ensureConfigWings(rootDir)
  const db = getDb(rootDir)
  const palaceContent = readLatestPalaceContent(db, {
    namespace: PALACE_NAMESPACE.config,
    wing,
    room: CONFIG_SOURCE_ROOM,
    nodeKey: wing,
    profileId: null,
  })
  if (palaceContent === null) throw new Error(`CONFIG wing ${wing} not found in SQLite Palace kernel`)
  try {
    return JSON.parse(palaceContent) as ConfigWingValueMap[T]
  } catch (error) {
    throw new Error(`CONFIG wing ${wing} contains invalid JSON in SQLite Palace kernel: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function writeConfigWing<T extends ConfigWingName>(rootDir: string, wing: T, value: ConfigWingValueMap[T]) {
  ensureConfigWings(rootDir)
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const content = JSON.stringify(value, null, 2)
  const currentPalace = readLatestPalaceContent(db, {
    namespace: PALACE_NAMESPACE.config,
    wing,
    room: CONFIG_SOURCE_ROOM,
    nodeKey: wing,
    profileId: null,
  })
  if ((currentPalace ?? "") === content) {
    return { changed: false, bytes: Buffer.byteLength(content) }
  }

  db.exec("BEGIN TRANSACTION")
  try {
    upsertMutablePalaceNode(db, {
      namespace: PALACE_NAMESPACE.config,
      wing,
      room: CONFIG_SOURCE_ROOM,
      nodeKey: wing,
      profileId: null,
      subjectType: "config_wing",
      subjectId: wing,
      contentType: "application/json",
      content,
      now,
    })
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
  appendPalaceNode(db, {
    namespace: PALACE_NAMESPACE.projectFacts,
    wing: "LOG_ACTIONS",
    room: ACTION_LOG_ROOM,
    nodeKey: "action",
    profileId: null,
    subjectType: "action_log",
    subjectId: action,
    contentType: "application/json",
    content: JSON.stringify(payload),
    now,
  })
}

export function listBootWings(rootDir: string, profileId = "default"): string[] {
  ensureBootWings(rootDir, profileId)
  const db = getDb(rootDir)
  const profileScope = palaceProfileScope(profileId)
  const rows = db.prepare(`
    SELECT DISTINCT wing
    FROM palace_nodes
    WHERE namespace = ?
      AND profile_scope = ?
      AND superseded_at IS NULL
    ORDER BY wing ASC
  `).all(PALACE_NAMESPACE.boot, profileScope) as Array<{ wing: string }>

  const knownOrder = new Map<string, number>(BOOT_WING_ORDER.map((wing, index) => [wing, index]))
  return rows
    .map(row => row.wing)
    .sort((left, right) => {
      const leftOrder = knownOrder.get(left) ?? Number.MAX_SAFE_INTEGER
      const rightOrder = knownOrder.get(right) ?? Number.MAX_SAFE_INTEGER
      return leftOrder === rightOrder ? left.localeCompare(right) : leftOrder - rightOrder
    })
}

export function bootWingExists(rootDir: string, wing: string, profileId = "default"): boolean {
  ensureBootWings(rootDir, profileId)
  const db = getDb(rootDir)
  const profileScope = palaceProfileScope(profileId)
  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM palace_nodes
    WHERE namespace = ?
      AND profile_scope = ?
      AND wing = ?
      AND node_key = ?
      AND superseded_at IS NULL
  `).get(PALACE_NAMESPACE.boot, profileScope, wing, wing) as { count: number }
  return row.count > 0
}

export function createBootWing(rootDir: string, wing: string, profileId = "default", content = "") {
  ensureBootWings(rootDir, profileId)
  const normalizedWing = wing.trim()
  if (!normalizedWing) throw new Error("BOOT wing must be a non-empty string")
  if (bootWingExists(rootDir, normalizedWing, profileId)) {
    return { created: false, wing: normalizedWing, profile: profileId }
  }

  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const result = upsertMutablePalaceNode(db, {
    namespace: PALACE_NAMESPACE.boot,
    wing: normalizedWing,
    room: BOOTSTRAP_SOURCE_ROOM,
    nodeKey: normalizedWing,
    profileId,
    subjectType: "boot_wing",
    subjectId: normalizedWing,
    contentType: "text/markdown",
    content,
    now,
  })
  return { created: result.changed, wing: normalizedWing, profile: profileId }
}

export function readBootWing(rootDir: string, wing: string, profileId = "default"): string | null {
  ensureBootWings(rootDir, profileId)
  const db = getDb(rootDir)
  const palaceContent = readLatestPalaceContent(db, {
    namespace: PALACE_NAMESPACE.boot,
    wing,
    room: BOOTSTRAP_SOURCE_ROOM,
    nodeKey: wing,
    profileId,
    includeGlobalFallback: true,
  })
  if (palaceContent !== null) return palaceContent
  throw new Error(`BOOT wing ${wing} not found in SQLite Palace kernel for profile ${profileId}`)
}

export function writeBootWing(rootDir: string, wing: string, content: string, profileId = "default", append = false) {
  ensureBootWings(rootDir, profileId)
  if (!bootWingExists(rootDir, wing, profileId)) {
    throw new Error(`BOOT wing ${wing} does not exist in profile ${profileId}. Use BootCreateWing after BootListWings if you need a new wing.`)
  }
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const currentPalace = readLatestPalaceContent(db, {
    namespace: PALACE_NAMESPACE.boot,
    wing,
    room: BOOTSTRAP_SOURCE_ROOM,
    nodeKey: wing,
    profileId,
  })
  let finalContent = content
  if (append && currentPalace !== null) {
    finalContent = `${currentPalace}\n\n${content}`
  }
  if ((currentPalace ?? "") === finalContent) {
    return { changed: false, bytes: Buffer.byteLength(finalContent) }
  }

  db.exec("BEGIN TRANSACTION")
  try {
    upsertMutablePalaceNode(db, {
      namespace: PALACE_NAMESPACE.boot,
      wing,
      room: BOOTSTRAP_SOURCE_ROOM,
      nodeKey: wing,
      profileId,
      subjectType: "boot_wing",
      subjectId: wing,
      contentType: "text/markdown",
      content: finalContent,
      now,
    })
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  return { changed: true, bytes: Buffer.byteLength(finalContent) }
}

export function listBootEntries(rootDir: string, profileId = "default", options?: { includeMemory?: boolean; maxCharsPerEntry?: number; maxTotalChars?: number }) {
  ensureBootWings(rootDir, profileId)
  const includeMemory = options?.includeMemory ?? true
  const maxCharsPerEntry = options?.maxCharsPerEntry ?? 20_000
  let remainingChars = options?.maxTotalChars ?? 150_000
  const entries: BootWingEntry[] = []

  for (const wing of listBootWings(rootDir, profileId)) {
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
  const stmt = db.prepare(`UPDATE sessions SET title = ?, state = ?, voice_mode = ?, updated_at = ? WHERE id = ?`)
  stmt.run(session.title, session.state, session.voiceMode ? 1 : 0, session.updatedAt, session.id)
}

export function getSession(rootDir: string, sessionId: string): SessionRecord | null {
  const db = getDb(rootDir)

  const stmtSession = db.prepare(`SELECT id, profile_id, title, state, created_at, updated_at, voice_mode FROM sessions WHERE id = ?`)
  const row = stmtSession.get(sessionId) as { id: string; profile_id: string | null; title: string | null; state: string | null; created_at: string; updated_at: string; voice_mode: number | null } | undefined
  if (!row) return null

  const stmtMsgs = db.prepare(
    `SELECT role, text, thinking, at FROM messages
     WHERE session_id = ? AND (hidden_from_user IS NULL OR hidden_from_user = 0)
     ORDER BY id ASC`,
  )
  const messages = stmtMsgs.all(sessionId) as Array<{ role: string; text: string; thinking: string | null; at: string }>

  const stmtLogs = db.prepare(`SELECT type, summary, at FROM worklog WHERE session_id = ? ORDER BY id ASC`)
  const worklogs = stmtLogs.all(sessionId) as Array<{ type: string; summary: string; at: string }>

  return {
    id: row.id,
    profileId: row.profile_id ?? "default",
    title: row.title ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state: (row.state ?? "idle") as "idle" | "running" | "error",
    voiceMode: row.voice_mode === 1,
    messages: messages.map(m => ({ at: m.at, role: m.role as "user" | "assistant" | "system", text: m.text, thinking: m.thinking ?? undefined })),
    worklog: worklogs.map(w => ({ at: w.at, type: w.type as "session" | "message" | "tool" | "note", summary: w.summary })),
  }
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
  let sql = `SELECT id, profile_id, title, state, created_at, updated_at, voice_mode FROM sessions`
  const params: any[] = []
  if (profileId) {
    sql += ` WHERE profile_id = ?`
    params.push(profileId)
  }
  sql += ` ORDER BY updated_at DESC`
  const stmt = db.prepare(sql)
  const rows = stmt.all(...params) as Array<{ id: string; profile_id: string | null; title: string | null; state: string | null; created_at: string; updated_at: string; voice_mode: number | null }>
  return rows.map(r => ({
    id: r.id,
    profileId: r.profile_id ?? "default",
    title: r.title ?? "",
    state: (r.state ?? "idle") as "idle" | "running" | "error",
    voiceMode: r.voice_mode === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export function listSessionRecords(rootDir: string): SessionRecord[] {
  const summaries = listSessions(rootDir)
  return summaries.map(s => getSession(rootDir, s.id)!)
}

export function getSemanticMessageContext(rootDir: string, vector: number[] | Float32Array, limit = 10) {
  const db = getDb(rootDir)
  const rows = db.prepare(`
    SELECT m.id, m.session_id, m.role, m.text, m.at, v.distance
    FROM vec_messages v
    JOIN messages m ON m.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND m.session_id NOT LIKE 'agent-%'
      AND m.session_id NOT LIKE 'worker-%'
    ORDER BY distance ASC
  `).all(vector instanceof Float32Array ? vector : Float32Array.from(vector), limit) as Array<{ id: number; session_id: string; role: string; text: string; at: string; distance?: number }>
  return rows
}

export interface AppendMessageOptions {
  /**
   * If true, the message is persisted to the DB but excluded from the
   * user-facing transcript (filtered by getSession). Used for internal
   * orchestration messages that the model needs to see (Ralph Gate
   * feedback, system event triggers, sub-agent interjections) but that
   * are not user output. The model still sees them on the next turn.
   *
   * Default: false.
   */
  hiddenFromUser?: boolean
  thinking?: string
}

export function appendMessage(
  rootDir: string,
  sessionId: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: AppendMessageOptions = {},
) {
  const db = getDb(rootDir)
  const now = new Date().toISOString()
  const hiddenFromUser = options.hiddenFromUser === true ? 1 : 0
  let messageId: number | null = null
  
  db.exec("BEGIN TRANSACTION")
  try {
    const stmtMsg = db.prepare(
      `INSERT INTO messages (session_id, role, text, thinking, at, hidden_from_user) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const messageResult = stmtMsg.run(sessionId, role, text, options.thinking ?? null, now, hiddenFromUser)
    messageId = Number(messageResult.lastInsertRowid)
    const sessionRow = db.prepare(`SELECT profile_id FROM sessions WHERE id = ?`).get(sessionId) as { profile_id: string | null } | undefined
    appendPalaceNode(db, {
      namespace: PALACE_NAMESPACE.chatHistory,
      wing: "messages",
      room: sessionId,
      nodeKey: String(messageResult.lastInsertRowid),
      profileId: sessionRow?.profile_id ?? "default",
      subjectType: "session_message",
      subjectId: sessionId,
      contentType: "application/json",
      content: JSON.stringify({
        legacyMessageId: messageResult.lastInsertRowid,
        sessionId,
        role,
        text,
        thinking: options.thinking ?? undefined,
        at: now,
      }),
      now,
    })

    const stmtWorklog = db.prepare(`INSERT INTO worklog (session_id, type, summary, at) VALUES (?, ?, ?, ?)`)
    stmtWorklog.run(sessionId, "message", buildMessageSummary(role, text), now)

    const stmtUpdate = db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
    stmtUpdate.run(now, sessionId)
    
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }

  if (messageId !== null && role !== "system" && text.trim()) {
    void indexMessageEmbedding(rootDir, sessionId, messageId, text)
  }
}

async function indexMessageEmbedding(rootDir: string, sessionId: string, messageId: number, text: string) {
  if (!isMainSession(sessionId)) return
  try {
    const embedding = await generateEmbedding(text)
    const db = getDb(rootDir)
    const id = BigInt(messageId)
    db.prepare(`DELETE FROM vec_messages WHERE id = ?`).run(id)
    db.prepare(`INSERT INTO vec_messages (id, embedding) VALUES (?, ?)`).run(id, embedding)
  } catch (error) {
    logger.warn("Embeddings fallaron, guardando mensaje sin vector: " + (error instanceof Error ? error.message : String(error)))
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
    const messageRows = db.prepare(`SELECT id FROM messages WHERE session_id = ?`).all(sessionId) as Array<{ id: number }>
    const deleteVec = db.prepare(`DELETE FROM vec_messages WHERE id = ?`)
    for (const row of messageRows) deleteVec.run(BigInt(row.id))
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM worklog WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM events WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM palace_nodes WHERE room = ? AND namespace = ? AND wing = ?`)
      .run(sessionId, PALACE_NAMESPACE.chatHistory, "websearch_history")
    db.prepare(`DELETE FROM palace_nodes WHERE room = ? AND namespace = ? AND wing = ?`)
      .run(sessionId, PALACE_NAMESPACE.chatHistory, "active_tasks")
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
  const now = new Date().toISOString()
  const rows = db.prepare(`
    SELECT rowid, id
    FROM memory_drawers
    WHERE profile_id = ?
      AND wing NOT LIKE 'CONF\\_%' ESCAPE '\\'
  `).all(profileId) as { rowid: number; id: string }[]
  const graphRows = db.prepare(`
    SELECT COUNT(*) as count
    FROM knowledge_graph
    WHERE profile_id = ?
  `).get(profileId) as { count: number }
  const palaceRows = db.prepare(`
    SELECT COUNT(*) as count
    FROM palace_nodes
    WHERE profile_scope = ?
      AND namespace NOT IN (?, ?, ?)
  `).get(palaceProfileScope(profileId), PALACE_NAMESPACE.config, PALACE_NAMESPACE.chatHistory, PALACE_NAMESPACE.boot) as { count: number }

  db.exec("BEGIN TRANSACTION")
  try {
    const deleteVec = db.prepare(`DELETE FROM vec_drawers WHERE id = ?`)
    for (const row of rows) {
      deleteVec.run(BigInt(row.rowid))
    }
    db.prepare(`
      DELETE FROM memory_drawers
      WHERE profile_id = ?
        AND wing NOT LIKE 'CONF\\_%' ESCAPE '\\'
    `).run(profileId)
    db.prepare(`DELETE FROM knowledge_graph WHERE profile_id = ?`).run(profileId)
    db.prepare(`
      DELETE FROM palace_nodes
      WHERE profile_scope = ?
        AND namespace NOT IN (?, ?, ?)
    `).run(palaceProfileScope(profileId), PALACE_NAMESPACE.config, PALACE_NAMESPACE.chatHistory, PALACE_NAMESPACE.boot)
    for (const wing of BOOT_WING_ORDER) {
      upsertMutablePalaceNode(db, {
        namespace: PALACE_NAMESPACE.boot,
        wing,
        room: BOOTSTRAP_SOURCE_ROOM,
        nodeKey: wing,
        profileId,
        subjectType: "boot_wing",
        subjectId: wing,
        contentType: "text/markdown",
        content: DEFAULT_BOOT_WING_CONTENT[wing],
        now,
      })
    }
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }

  ensureBootWings(rootDir, profileId)
  return {
    memoryRowsDeleted: rows.length,
    graphRowsDeleted: graphRows.count,
    palaceRowsDeleted: palaceRows.count,
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
        db.prepare(`DELETE FROM vec_messages WHERE id = ?`).run(BigInt(candidate.id))
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
  const removed = stmtToCompact.all(sessionId, toRemoveCount) as Array<{ id: number; role: string; at: string; text: string }>
  
  const userCount = removed.filter(m => m.role === "user").length
  const assistantCount = removed.filter(m => m.role === "assistant").length
  const systemCount = removed.filter(m => m.role === "system").length
  
  const firstAt = removed[0]?.at
  const lastIdRemoved = removed[removed.length - 1]?.id ?? 0

  db.exec("BEGIN TRANSACTION")
  try {
    const deleteVec = db.prepare(`DELETE FROM vec_messages WHERE id = ?`)
    for (const row of removed) deleteVec.run(BigInt(row.id))
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
    floatArray = await generateEmbedding(content)
  } catch (error) {
    logger.warn("Embeddings fallaron, guardando memoria sin vectores: " + (error instanceof Error ? error.message : String(error)))
    if (!isEmbeddingsUnavailableError(error)) throw error
  }
  
  db.exec("BEGIN TRANSACTION")
  try {
    const stmt = db.prepare(`INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const result = stmt.run(id, storedProfileId, normalizedWing, normalizedRoom, normalizedKey, content, now)
    appendPalaceNode(db, {
      namespace: PALACE_NAMESPACE.projectFacts,
      wing: normalizedWing,
      room: normalizedRoom,
      nodeKey: normalizedKey,
      profileId: storedProfileId,
      subjectType: "memory_drawer",
      subjectId: normalizedKey ?? normalizedRoom,
      contentType: "text/plain",
      content,
      now,
    })

    // Vector storage. Two paths:
    //   - Legacy (default): one vector in vec_drawers keyed by drawer rowid.
    //   - Multi-chunk (env MONOLITO_USE_MULTI_CHUNK_EMBEDDINGS=1): one vector
    //     per chunk in vec_drawer_chunks. The legacy vec_drawers row still
    //     gets a fallback vector (first chunk) so old recall paths keep working.
    if (isMultiChunkEmbeddingsEnabled()) {
      const chunked = await embedChunked(content, { targetTokens: 1500, overlapTokens: 150 })
      if (chunked.length > 0) {
        const drawerRowid = Number(result.lastInsertRowid)
        insertChunkEmbeddings(db, drawerRowid, chunked)
        // Legacy fallback: insert the first chunk's vector into vec_drawers.
        const stmtVec = db.prepare(`INSERT OR IGNORE INTO vec_drawers (id, embedding) VALUES (?, ?)`)
        stmtVec.run(BigInt(drawerRowid), chunked[0]!.embedding)
      }
      // No embedding at all: skip both tables.
    } else if (floatArray) {
      const stmtVec = db.prepare(`INSERT INTO vec_drawers (id, embedding) VALUES (?, ?)`)
      stmtVec.run(BigInt(result.lastInsertRowid), floatArray)
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
    // Multi-chunk path: vector stored as one row per chunk in vec_drawer_chunks.
    if (isMultiChunkEmbeddingsEnabled()) {
      const queryVector = await generateEmbedding(query)
      const hits = recallMultiChunk(
        db,
        queryVector,
        {
          wing,
          room,
          key,
          profileId,
          excludeWings: ["BOOT\\_", "CONF\\_"],
        },
        15,
        200,
      )
      // Reshape to legacy contract: { id, profile_id, wing, room, memory_key, content, created_at, distance }.
      return hits.map((h) => ({
        id: h.drawerId,
        profile_id: h.profileId,
        wing: h.wing,
        room: h.room,
        memory_key: h.memoryKey,
        content: h.content,
        created_at: h.createdAt,
        distance: h.meanDistance,
      }))
    }

    const floatArray = await generateEmbedding(query)
    let sql = `SELECT m.id, m.profile_id, m.wing, m.room, m.memory_key, m.content, m.created_at,
                      v.distance
               FROM vec_drawers v
               JOIN memory_drawers m ON m.rowid = v.id
               WHERE v.embedding MATCH ? AND k = 50`

    if (conditions.length > 0) {
      sql += ` AND ` + conditions.join(" AND ")
    }

    sql += ` ORDER BY v.distance ASC LIMIT 15`

    const stmt = db.prepare(sql)
    return stmt.all(floatArray, ...params) as Array<{ id: number; profile_id: string | null; wing: string; room: string; memory_key: string | null; content: string; created_at: string; distance: number }>
  } else {
    // Non-semantic pure recall
    let sql = `SELECT id, profile_id, wing, room, memory_key, content, created_at FROM memory_drawers m`
    if (conditions.length > 0) {
      sql += ` WHERE ` + conditions.join(" AND ")
    }
    sql += ` ORDER BY m.created_at DESC LIMIT 50`

    const stmt = db.prepare(sql)
    return stmt.all(...params) as Array<{ id: number; profile_id: string | null; wing: string; room: string; memory_key: string | null; content: string; created_at: string }>
  }
}

export function listProfiles(rootDir: string) {
  const db = getDb(rootDir)
  const stmt = db.prepare(`SELECT id, name, description, created_at FROM profiles ORDER BY name ASC`)
  return stmt.all() as Array<{ id: string; name: string; description: string | null; created_at: string }>
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

// --- Background Embeddings Synchronization ---

export async function syncMissingEmbeddings(rootDir: string) {
  const db = getDb(rootDir)
  
  // Automated migration: Check if vectors are normalized
  try {
    const sampleDrawer = db.prepare(`SELECT embedding FROM vec_drawers LIMIT 1`).get() as { embedding: Buffer } | undefined
    const sampleMessage = db.prepare(`SELECT embedding FROM vec_messages LIMIT 1`).get() as { embedding: Buffer } | undefined
    const sample = sampleDrawer ?? sampleMessage
    if (sample?.embedding) {
      const floatArray = new Float32Array(sample.embedding.buffer, sample.embedding.byteOffset, sample.embedding.byteLength / 4)
      let sum = 0
      for (let i = 0; i < floatArray.length; i++) {
        sum += floatArray[i] * floatArray[i]
      }
      const magnitude = Math.sqrt(sum)
      if (Math.abs(magnitude - 1.0) > 0.05) {
        logger.info("Unnormalized vectors detected in vector database. Wiping tables for automated regeneration...")
        db.prepare("DELETE FROM vec_drawers").run()
        db.prepare("DELETE FROM vec_messages").run()
      }
    }
  } catch (error) {
    logger.error(`Failed to run automated vector normalization check: ${error}`)
  }

  // 1. Find missing message embeddings
  const missingMessages = db.prepare(`
    SELECT id, text 
    FROM messages 
    WHERE role != 'system' 
      AND is_compacted = 0 
      AND session_id NOT LIKE 'agent-%' 
      AND session_id NOT LIKE 'worker-%'
      AND text != ''
      AND id NOT IN (SELECT id FROM vec_messages)
  `).all() as Array<{ id: number; text: string }>

  let messagesSynced = 0
  for (const row of missingMessages) {
    try {
      const embedding = await generateEmbedding(row.text)
      db.prepare(`DELETE FROM vec_messages WHERE id = ?`).run(BigInt(row.id))
      db.prepare(`INSERT INTO vec_messages (id, embedding) VALUES (?, ?)`).run(BigInt(row.id), embedding)
      messagesSynced++
    } catch (error) {
      if (isEmbeddingsUnavailableError(error)) {
        logger.warn("Sync aborted: Embeddings unavailable.")
        return // Abort early if Ollama is down again
      }
      logger.error(`Failed to sync embedding for message ${row.id}: ${error}`)
    }
  }

  // 2. Find missing memory drawer embeddings
  const missingDrawers = db.prepare(`
    SELECT rowid, id, content 
    FROM memory_drawers 
    WHERE wing NOT LIKE 'CONF\\_%' ESCAPE '\\'
      AND content != ''
      AND rowid NOT IN (SELECT id FROM vec_drawers)
  `).all() as Array<{ rowid: number; id: string; content: string }>

  let drawersSynced = 0
  for (const row of missingDrawers) {
    try {
      const embedding = await generateEmbedding(row.content)
      db.prepare(`DELETE FROM vec_drawers WHERE id = ?`).run(BigInt(row.rowid))
      db.prepare(`INSERT INTO vec_drawers (id, embedding) VALUES (?, ?)`).run(BigInt(row.rowid), embedding)
      drawersSynced++
    } catch (error) {
      if (isEmbeddingsUnavailableError(error)) {
        logger.warn("Sync aborted: Embeddings unavailable.")
        return
      }
      logger.error(`Failed to sync embedding for drawer ${row.id}: ${error}`)
    }
  }

  if (messagesSynced > 0 || drawersSynced > 0) {
    logger.info(`Embeddings sync completed: ${messagesSynced} messages, ${drawersSynced} memory drawers.`)
  }
}

export async function upsertSemanticTool(rootDir: string, name: string, description: string) {
  const db = getDb(rootDir)
  const wing = "CONF_TOOLS"
  const room = "registry"
  const now = new Date().toISOString()
  
  // Check if already exists and has the same content
  const existing = db.prepare(`
    SELECT rowid, id, content FROM memory_drawers
    WHERE wing = ? AND room = ? AND memory_key = ?
    LIMIT 1
  `).get(wing, room, name) as { rowid: number; id: string; content: string } | undefined

  if (existing) {
    if (existing.content === description) {
      // Check if it already has an embedding
      const hasVec = db.prepare(`SELECT 1 FROM vec_drawers WHERE id = ?`).get(BigInt(existing.rowid))
      if (hasVec) return
    }
    // Update content
    db.prepare(`
      UPDATE memory_drawers
      SET content = ?
      WHERE id = ?
    `).run(description, existing.id)
    try {
      const floatArray = await generateEmbedding(description)
      db.prepare(`DELETE FROM vec_drawers WHERE id = ?`).run(BigInt(existing.rowid))
      db.prepare(`INSERT INTO vec_drawers (id, embedding) VALUES (?, ?)`).run(BigInt(existing.rowid), floatArray)
    } catch (err) {
      logger.error(`Failed to update tool embedding for ${name}: ${err}`)
    }
    return
  }

  // Create new
  const id = randomUUID()
  const result = db.prepare(`
    INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?)
  `).run(id, wing, room, name, description, now)

  try {
    const floatArray = await generateEmbedding(description)
    db.prepare(`DELETE FROM vec_drawers WHERE id = ?`).run(BigInt(result.lastInsertRowid))
    db.prepare(`INSERT INTO vec_drawers (id, embedding) VALUES (?, ?)`).run(BigInt(result.lastInsertRowid), floatArray)
  } catch (err) {
    logger.error(`Failed to generate tool embedding for ${name}: ${err}`)
  }
}

export async function querySemanticTools(rootDir: string, prompt: string, limit = 5): Promise<string[]> {
  const wing = "CONF_TOOLS"
  const room = "registry"
  try {
    const db = getDb(rootDir)
    const floatArray = await generateEmbedding(prompt)
    const sql = `
      SELECT m.memory_key as name
      FROM vec_drawers v
      JOIN memory_drawers m ON m.rowid = v.id
      WHERE m.wing = ? AND m.room = ?
        AND v.embedding MATCH ? AND k = 50
      ORDER BY v.distance ASC
      LIMIT ?
    `
    const rows = db.prepare(sql).all(wing, room, floatArray, limit) as Array<{ name: string }>
    return rows.map(r => r.name)
  } catch (error) {
    logger.error(`Error querying semantic tools for prompt: ${error}`)
    return []
  }
}

export function upsertRalphRule(rootDir: string, key: string, ruleJson: string): void {
  const db = getDb(rootDir)
  const wing = "CONF_RALPH_RULES"
  const room = "rules"
  const now = new Date().toISOString()

  const existing = db.prepare(`
    SELECT id, content FROM memory_drawers
    WHERE wing = ? AND room = ? AND memory_key = ?
    LIMIT 1
  `).get(wing, room, key) as { id: string; content: string } | undefined

  if (existing) {
    if (existing.content === ruleJson) {
      return
    }
    db.prepare(`
      UPDATE memory_drawers
      SET content = ?
      WHERE id = ?
    `).run(ruleJson, existing.id)
    return
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?)
  `).run(id, wing, room, key, ruleJson, now)
}

export function listRalphRules(rootDir: string): Array<{ key: string; content: string }> {
  const db = getDb(rootDir)
  const wing = "CONF_RALPH_RULES"
  const room = "rules"
  const rows = db.prepare(`
    SELECT memory_key as key, content
    FROM memory_drawers
    WHERE wing = ? AND room = ?
  `).all(wing, room) as Array<{ key: string; content: string }>
  return rows
}

export type SkillProvenance = "agent" | "user" | "imported"

export interface DynamicSkill {
  name: string
  description: string
  author: string
  guide: string // Manual operativo en Markdown (instrucciones, pasos, pitfalls)
  requiresTools?: string[] // Lista de herramientas nativas de Monolito requeridas
  telemetry?: {
    use_count: number
    last_used_at: string
    failure_count: number
  }
  active: boolean
  // Provenance: who created this skill. Curator only touches "agent" skills.
  // Default for legacy skills without provenance is "user" (defensive: protects them).
  provenance?: SkillProvenance
  createdAt?: string
  updatedAt?: string
  // Archive fields: archived skills are kept in DB but excluded from <available_skills>.
  archivedAt?: string
  archiveReason?: string
}

export function saveDynamicSkill(rootDir: string, skill: DynamicSkill): void {
  const db = getDb(rootDir)
  const wing = "CONF_SKILLS"
  const room = "registry"
  const now = new Date().toISOString()
  const skillWithTelemetry = {
    ...skill,
    telemetry: skill.telemetry || { use_count: 0, last_used_at: now, failure_count: 0 },
    updatedAt: skill.updatedAt || now,
    // Defensive: legacy skills without provenance default to "user" (curator won't touch).
    provenance: skill.provenance || "user",
  }
  // Preserve createdAt on update.
  if (!skillWithTelemetry.createdAt) {
    skillWithTelemetry.createdAt = now
  }
  const skillJson = JSON.stringify(skillWithTelemetry)

  const existing = db.prepare(`
    SELECT id, content FROM memory_drawers
    WHERE wing = ? AND room = ? AND memory_key = ?
    LIMIT 1
  `).get(wing, room, skill.name) as { id: string; content: string } | undefined

  if (existing) {
    // Preserve original createdAt if not provided in the incoming skill.
    try {
      const parsed = JSON.parse(existing.content) as DynamicSkill
      if (parsed.createdAt && !skill.createdAt) {
        skillWithTelemetry.createdAt = parsed.createdAt
      }
    } catch {
      // ignore
    }
    const finalJson = JSON.stringify(skillWithTelemetry)
    db.prepare(`
      UPDATE memory_drawers
      SET content = ?
      WHERE id = ?
    `).run(finalJson, existing.id)
    return
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?)
  `).run(id, wing, room, skill.name, skillJson, now)
}

export interface ListSkillsFilter {
  provenance?: SkillProvenance | SkillProvenance[]
  active?: boolean
  includeArchived?: boolean
}

export function listDynamicSkills(rootDir: string, filter?: ListSkillsFilter): DynamicSkill[] {
  const db = getDb(rootDir)
  const wing = "CONF_SKILLS"
  const room = "registry"
  const rows = db.prepare(`
    SELECT content
    FROM memory_drawers
    WHERE wing = ? AND room = ?
  `).all(wing, room) as Array<{ content: string }>

  const all = rows.map(r => {
    try {
      return JSON.parse(r.content) as DynamicSkill
    } catch {
      return null
    }
  }).filter((s): s is DynamicSkill => s !== null)

  return all.filter(skill => {
    if (filter?.active !== undefined) {
      if (filter.active && !skill.active) return false
      if (!filter.active && skill.active) return false
    } else if (filter?.includeArchived !== true) {
      // Default: only return active skills (backwards compat).
      if (!skill.active) return false
    }
    if (filter?.provenance) {
      const wanted = Array.isArray(filter.provenance) ? filter.provenance : [filter.provenance]
      const actual = skill.provenance || "user"
      if (!wanted.includes(actual)) return false
    }
    return true
  })
}

export function archiveDynamicSkill(rootDir: string, name: string, reason?: string): { ok: boolean; error?: string } {
  const skill = getDynamicSkill(rootDir, name)
  if (!skill) return { ok: false, error: `Skill '${name}' not found.` }
  const now = new Date().toISOString()
  saveDynamicSkill(rootDir, {
    ...skill,
    active: false,
    archivedAt: now,
    archiveReason: reason,
    updatedAt: now,
  })
  return { ok: true }
}

export function restoreArchivedSkill(rootDir: string, name: string): { ok: boolean; error?: string } {
  const skill = getDynamicSkill(rootDir, name)
  if (!skill) return { ok: false, error: `Skill '${name}' not found.` }
  const now = new Date().toISOString()
  const restored: DynamicSkill = {
    ...skill,
    active: true,
    updatedAt: now,
  }
  delete restored.archivedAt
  delete restored.archiveReason
  saveDynamicSkill(rootDir, restored)
  return { ok: true }
}

export function getDynamicSkill(rootDir: string, name: string): DynamicSkill | undefined {
  const db = getDb(rootDir)
  const wing = "CONF_SKILLS"
  const room = "registry"
  const row = db.prepare(`
    SELECT content
    FROM memory_drawers
    WHERE wing = ? AND room = ? AND memory_key = ?
    LIMIT 1
  `).get(wing, room, name) as { content: string } | undefined

  if (!row) return undefined
  try {
    return JSON.parse(row.content) as DynamicSkill
  } catch {
    return undefined
  }
}

export function deleteDynamicSkill(rootDir: string, name: string): void {
  const db = getDb(rootDir)
  const wing = "CONF_SKILLS"
  const room = "registry"
  
  const existing = db.prepare(`
    SELECT rowid, id FROM memory_drawers
    WHERE wing = ? AND room = ? AND memory_key = ?
    LIMIT 1
  `).get(wing, room, name) as { rowid: number; id: string } | undefined

  if (existing) {
    db.prepare(`DELETE FROM vec_drawers WHERE id = ?`).run(BigInt(existing.rowid))
    db.prepare(`DELETE FROM memory_drawers WHERE id = ?`).run(existing.id)
  }
}

export function incrementSkillTelemetry(rootDir: string, name: string, success: boolean): void {
  const skill = getDynamicSkill(rootDir, name)
  if (!skill) return
  
  const telemetry = skill.telemetry || { use_count: 0, last_used_at: new Date().toISOString(), failure_count: 0 }
  telemetry.use_count += 1
  telemetry.last_used_at = new Date().toISOString()
  if (!success) {
    telemetry.failure_count += 1
  }
  
  skill.telemetry = telemetry
  saveDynamicSkill(rootDir, skill)
}

export function isSessionResearchSilent(rootDir: string, sessionId: string, profileId = "default"): boolean {
  const db = getDb(rootDir)
  const profileScope = palaceProfileScope(profileId)
  const row = db.prepare(`
    SELECT content
    FROM palace_nodes
    WHERE namespace = ?
      AND wing = 'SESSION_PREFERENCES'
      AND room = ?
      AND node_key = 'pref_silent_research'
      AND (profile_scope = ? OR profile_scope = '__global__')
      AND superseded_at IS NULL
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `).get(PALACE_NAMESPACE.projectFacts, sessionId, profileScope) as { content: string } | undefined

  return row?.content === "true"
}

export function getRawMessagesForSession(rootDir: string, sessionId: string): Array<{ id: number; role: string; text: string; at: string; is_compacted: number }> {
  const db = getDb(rootDir)
  return db.prepare(`SELECT id, role, text, at, is_compacted FROM messages WHERE session_id = ? ORDER BY id ASC`).all(sessionId) as Array<{ id: number; role: string; text: string; at: string; is_compacted: number }>
}

export function rewriteMessageInPlace(rootDir: string, messageId: number, text: string, isCompacted: number = 1) {
  const db = getDb(rootDir)
  db.prepare(`UPDATE messages SET text = ?, is_compacted = ? WHERE id = ?`).run(text, isCompacted, messageId)
  try {
    db.prepare(`DELETE FROM vec_messages WHERE id = ?`).run(BigInt(messageId))
  } catch {}
}

export function deleteMessages(rootDir: string, messageIds: number[]) {
  if (messageIds.length === 0) return
  const db = getDb(rootDir)
  db.exec("BEGIN TRANSACTION")
  try {
    const stmtDel = db.prepare(`DELETE FROM messages WHERE id = ?`)
    const stmtDelVec = db.prepare(`DELETE FROM vec_messages WHERE id = ?`)
    for (const id of messageIds) {
      stmtDel.run(id)
      try {
        stmtDelVec.run(BigInt(id))
      } catch {}
    }
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

export async function recallProfileFacts(rootDir: string, query: string, profileId = "default"): Promise<string[]> {
  try {
    let userText = ""
    let memText = ""
    let identityText = ""
    try { userText = readBootWing(rootDir, "BOOT_USER", profileId) ?? "" } catch {}
    try { memText = readBootWing(rootDir, "BOOT_MEMORY", profileId) ?? "" } catch {}
    try { identityText = readBootWing(rootDir, "BOOT_IDENTITY", profileId) ?? "" } catch {}
    
    const combinedText = `${userText}\n\n${memText}\n\n${identityText}`
    
    // Split into meaningful paragraphs or bullet points
    const paragraphs = combinedText
      .split(/\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 10 && !p.startsWith("#") && !p.startsWith("---"))
      
    if (paragraphs.length === 0) return []
    
    const queryVec = await generateEmbedding(query)
    const matches: Array<{ text: string; score: number }> = []
    
    for (const paragraph of paragraphs) {
      try {
        const paragraphVec = await generateEmbedding(paragraph)
        const score = cosineSimilarity(queryVec, paragraphVec)
        matches.push({ text: paragraph, score })
      } catch (err) {
        // Skip individual failure
      }
    }
    
    // Sort by score descending and take the ones above 0.55 threshold
    return matches
      .sort((a, b) => b.score - a.score)
      .filter(m => m.score > 0.55)
      .slice(0, 3)
      .map(m => m.text)
  } catch (error) {
    logger.error("Error recalling profile facts semantically:", error)
    return []
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

export async function saveResolvedError(
  rootDir: string,
  errorSnippet: string,
  solutionSnippet: string
): Promise<void> {
  const db = getDb(rootDir)
  const wing = "CONF_ERRORS"
  const room = "resolved_errors"
  const now = new Date().toISOString()
  
  const content = JSON.stringify({ error: errorSnippet, solution: solutionSnippet })
  const memoryKey = createHash("sha256").update(errorSnippet.trim()).digest("hex")

  // Check if it already exists to avoid duplicate work/vector inserts
  const existing = db.prepare(`
    SELECT rowid, id FROM memory_drawers
    WHERE wing = ? AND room = ? AND memory_key = ?
    LIMIT 1
  `).get(wing, room, memoryKey) as { rowid: number; id: string } | undefined

  if (existing) {
    db.prepare(`
      UPDATE memory_drawers
      SET content = ?, created_at = ?
      WHERE id = ?
    `).run(content, now, existing.id)
    
    try {
      const floatArray = await generateEmbedding(errorSnippet)
      db.prepare(`DELETE FROM vec_drawers WHERE id = ?`).run(BigInt(existing.rowid))
      db.prepare(`INSERT INTO vec_drawers (id, embedding) VALUES (?, ?)`).run(BigInt(existing.rowid), floatArray)
    } catch (err) {
      logger.error(`Failed to update resolved error embedding: ${err}`)
    }
    return
  }

  // Create new
  const id = randomUUID()
  const result = db.prepare(`
    INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?)
  `).run(id, wing, room, memoryKey, content, now)

  try {
    const floatArray = await generateEmbedding(errorSnippet)
    db.prepare(`DELETE FROM vec_drawers WHERE id = ?`).run(BigInt(result.lastInsertRowid))
    db.prepare(`INSERT INTO vec_drawers (id, embedding) VALUES (?, ?)`).run(BigInt(result.lastInsertRowid), floatArray)
  } catch (err) {
    logger.error(`Failed to generate resolved error embedding: ${err}`)
  }
}

export async function querySimilarErrors(
  rootDir: string,
  errorSnippet: string,
  limit = 1
): Promise<{ error: string; solution: string } | null> {
  const db = getDb(rootDir)
  const wing = "CONF_ERRORS"
  const room = "resolved_errors"

  try {
    const queryVector = await generateEmbedding(errorSnippet)
    
    // 1. Vector similarity query using MATCH
    const matches = db.prepare(`
      SELECT v.id as row_id, v.distance
      FROM vec_drawers v
      WHERE v.embedding MATCH ? AND v.k = ?
      ORDER BY v.distance ASC
    `).all(queryVector, limit + 5) as Array<{ row_id: number; distance: number }>

    if (matches.length === 0) return null

    // 2. Resolve matching rowids to memory drawers
    for (const match of matches) {
      const drawer = db.prepare(`
        SELECT content FROM memory_drawers
        WHERE rowid = ? AND wing = ? AND room = ?
        LIMIT 1
      `).get(BigInt(match.row_id), wing, room) as { content: string } | undefined

      if (drawer?.content) {
        // Cosine distance is returned by match distance.
        // Let's filter to make sure similarity is high enough (distance < 0.40)
        if (match.distance < 0.40) {
          try {
            return JSON.parse(drawer.content) as { error: string; solution: string }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
  } catch (err) {
    logger.error(`Failed to query similar errors semantically: ${err}`)
  }
  return null
}

/**
 * Persist a raw Telegram update before the channel manager processes it.
 * This is the durability mechanism that lets the daemon crash mid-process
 * without losing the user's message. After successful processing, call
 * markTelegramUpdateProcessed() to record the completion.
 *
 * Idempotency: Telegram re-delivers the same update_id on re-poll if the
 * poller's offset is not advanced. The PRIMARY KEY on update_id ensures
 * we never persist the same update twice.
 */
export function persistTelegramUpdate(
  rootDir: string,
  updateId: number,
  chatId: number | null,
  rawJson: string,
): { ok: boolean; error?: string } {
  try {
    const db = getDb(rootDir)
    const now = new Date().toISOString()
    db.prepare(
      `INSERT OR IGNORE INTO telegram_raw_updates (update_id, chat_id, received_at, raw_json)
       VALUES (?, ?, ?, ?)`,
    ).run(updateId, chatId, now, rawJson)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Mark a Telegram update as processed. Called AFTER the channel manager
 * has successfully dispatched the message to the runtime. If the daemon
 * crashes between persistTelegramUpdate and this call, the next startup
 * will see the unprocessed update and either re-poll Telegram (which
 * will re-deliver) or replay it from the table.
 */
export function markTelegramUpdateProcessed(rootDir: string, updateId: number): void {
  try {
    const db = getDb(rootDir)
    db.prepare(
      `UPDATE telegram_raw_updates SET processed_at = ? WHERE update_id = ?`,
    ).run(new Date().toISOString(), updateId)
  } catch {
    // best-effort; do not throw from a hot path
  }
}

/**
 * Returns the count of unprocessed Telegram updates that the daemon
 * still needs to handle. Used at startup to detect "did the daemon
 * crash mid-process" and to surface that to the user.
 */
export function countUnprocessedTelegramUpdates(rootDir: string): number {
  try {
    const db = getDb(rootDir)
    const row = db.prepare(
      `SELECT COUNT(*) as n FROM telegram_raw_updates WHERE processed_at IS NULL`,
    ).get() as { n: number }
    return row.n
  } catch {
    return 0
  }
}

