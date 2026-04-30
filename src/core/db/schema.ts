export type WorkerJobStatus = "pending" | "running" | "completed" | "failed"

export const PALACE_NAMESPACE = {
  boot: "BOOT_WING",
  config: "CONFIG_WING",
  chatHistory: "chat_history",
  projectFacts: "project_facts",
} as const

export type PalaceNamespace = (typeof PALACE_NAMESPACE)[keyof typeof PALACE_NAMESPACE]

export type PalaceContentType = "text/markdown" | "application/json" | "text/plain"

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
