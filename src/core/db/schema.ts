export type WorkerJobStatus = "pending" | "running" | "completed" | "failed"

export const PALACE_NAMESPACE = {
  boot: "BOOT_WING",
  config: "CONFIG_WING",
  chatHistory: "chat_history",
  identity: "identity",
  projectFacts: "project_facts",
} as const

export type PalaceNamespace = (typeof PALACE_NAMESPACE)[keyof typeof PALACE_NAMESPACE]

export type PalaceContentType = "text/markdown" | "application/json" | "text/plain"

export const VECTOR_DIMENSIONS = 1024

export const VECTOR_SCHEMA_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_drawers USING vec0(
    id INTEGER PRIMARY KEY,
    embedding float[1024]
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(
    id INTEGER PRIMARY KEY,
    embedding float[1024]
  );

  -- Multi-chunk embeddings for long memory drawers.
  -- See db/migrations/20260608_vec_drawer_chunks.sql.
  -- Schema rationale:
  --   - vec0 (sqlite-vec) only supports a single INTEGER PRIMARY KEY column.
  --   - SQLite does NOT allow CREATE INDEX on virtual tables.
  --   - Therefore: vec_drawer_chunks holds ONLY the vector + an autoincrement
  --     id (sqlite rowid). The (drawer_rowid, chunk_index) metadata is kept
  --     in a regular table named drawer_chunk_meta, FK-style.
  --   - The unique invariant (one vector per chunk per drawer) is enforced
  --     by a UNIQUE INDEX on drawer_chunk_meta(drawer_rowid, chunk_index).
  --   - Inserts go through insertChunkEmbeddings which first upserts the
  --     meta row (to get a stable chunk_id), then INSERT OR IGNORE into
  --     vec_drawer_chunks keyed by that chunk_id. Re-runs are idempotent.
  -- Convives con vec_drawers (legacy single-vector per drawer).
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_drawer_chunks USING vec0(
    id INTEGER PRIMARY KEY,
    embedding float[1024]
  );
`

export interface PalaceNode {
  id: string
  namespace: string
  wing: string
  room: string
  node_key: string | null
  profile_id: string | null
  profile_scope: string
  subject_type: string | null
  subject_id: string | null
  content_type: PalaceContentType
  content: string
  mutable: 0 | 1
  created_at: string
  updated_at: string
  superseded_at: string | null
}

export const PALACE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS palace_nodes (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    wing TEXT NOT NULL,
    room TEXT NOT NULL,
    node_key TEXT,
    profile_id TEXT,
    profile_scope TEXT NOT NULL DEFAULT '__global__',
    subject_type TEXT,
    subject_id TEXT,
    content_type TEXT NOT NULL DEFAULT 'text/plain',
    content TEXT NOT NULL,
    mutable INTEGER NOT NULL DEFAULT 0 CHECK (mutable IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    superseded_at TEXT,
    FOREIGN KEY(profile_id) REFERENCES profiles(id)
  );

  CREATE INDEX IF NOT EXISTS idx_palace_nodes_namespace
    ON palace_nodes(namespace);
  CREATE INDEX IF NOT EXISTS idx_palace_nodes_wing
    ON palace_nodes(wing);
  CREATE INDEX IF NOT EXISTS idx_palace_nodes_profile
    ON palace_nodes(profile_scope, namespace);
  CREATE INDEX IF NOT EXISTS idx_palace_nodes_subject
    ON palace_nodes(subject_type, subject_id);
  CREATE INDEX IF NOT EXISTS idx_palace_nodes_lookup
    ON palace_nodes(namespace, wing, room, node_key, profile_scope, superseded_at);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_palace_nodes_active_mutable
    ON palace_nodes(namespace, wing, room, node_key, profile_scope)
    WHERE mutable = 1 AND superseded_at IS NULL AND node_key IS NOT NULL;
`

export type BackgroundTaskStatus = "PENDING" | "IN_PROGRESS" | "HANDOFF" | "DONE" | "FAILED"

export interface BackgroundTask {
  id: string
  session_id: string
  agent_id: string | null
  status: BackgroundTaskStatus
  task_payload: string
  result_diff: string | null
  error_text: string | null
  created_at: string
  updated_at: string
  handoff_at: string | null
}

export const BACKGROUND_TASKS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS background_tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_PROGRESS', 'HANDOFF', 'DONE', 'FAILED')),
    task_payload TEXT NOT NULL,
    result_diff TEXT,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    handoff_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_bg_tasks_session
    ON background_tasks(session_id);
  CREATE INDEX IF NOT EXISTS idx_bg_tasks_status
    ON background_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_bg_tasks_agent
    ON background_tasks(agent_id);
`

export interface WorkerJob {
  id: string
  session_id: string
  profile_id: string | null
  tool_name: string
  tool_args: string
  status: WorkerJobStatus
  result_text: string | null
  error_text: string | null
  created_at: string
  updated_at: string
}
