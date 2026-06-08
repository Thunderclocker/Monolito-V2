-- 2026-06-08: Durable processing cursor for process-and-flush pipelines.
--
-- Used by src/core/utils/cursor.ts to track progress of long-running
-- stream processors (memory consolidation, context flush, multi-chunk
-- embeddings, etc.). Mirrors the pattern of telegram_raw_updates
-- (PK natural + last_processed_at + counters).
--
-- Stream ID conventions:
--   memcons:<sessionId>:<profileId>     — Memory consolidation per session
--   ctxflush:<sessionId>                — Context-engine incremental flush
--   embsync:<sourceId>                  — Embedding sync of long content
--
-- The `position` field is the next index/offset to process (0-based,
-- exclusive of what's already done). `total_processed` and `total_errors`
-- are observability counters, NOT position replacements — they survive
-- resets.
--
-- The `meta` field is opaque JSON for caller-defined state (e.g. list of
-- processed drawer_ids, last batch timestamp, etc.).

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
