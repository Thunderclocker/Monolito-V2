-- 2026-06-08: Multi-chunk embeddings for long memory drawers.
--
-- Before: fileMemory called /api/embeddings once with the FULL content.
-- If content > ~8K tokens (bge-m3 num_ctx), Ollama returned 500 and the
-- wrapper silently dropped to a zero-vector. This poisoned MemoryAgent
-- consolidation and context-engine recall.
--
-- After: when MONOLITO_USE_MULTI_CHUNK_EMBEDDINGS=1, fileMemory chunks the
-- content (1500 tokens target, 150 overlap) and stores one vector per chunk
-- in vec_drawer_chunks. The legacy vec_drawers table keeps a fallback vector
-- (first chunk) for backward compatibility.
--
-- Recall (when flag is on) does MATCH against vec_drawer_chunks, joins
-- with drawer_chunk_meta to resolve chunk_id → (drawer_rowid, chunk_index),
-- groups by drawer_rowid, computes mean distance, and returns top drawers.
--
-- Schema notes (split because of vec0 / virtual-table constraints):
-- 1. vec0 (sqlite-vec) only supports a single INTEGER PRIMARY KEY column.
-- 2. SQLite does NOT allow CREATE INDEX on virtual tables.
-- So we keep only the vector + an autoincrement `id` in vec_drawer_chunks.
-- The (drawer_rowid, chunk_index) → chunk_id mapping lives in the regular
-- table drawer_chunk_meta, with a UNIQUE INDEX on (drawer_rowid, chunk_index)
-- enforcing the "one vector per chunk per drawer" invariant.
--
-- Same float[1024] dims as vec_drawers (bge-m3 output).

CREATE VIRTUAL TABLE IF NOT EXISTS vec_drawer_chunks USING vec0(
  id INTEGER PRIMARY KEY,
  embedding float[1024]
);

CREATE TABLE IF NOT EXISTS drawer_chunk_meta (
  chunk_id INTEGER PRIMARY KEY,
  drawer_rowid INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_drawer_chunk_meta_unique
  ON drawer_chunk_meta(drawer_rowid, chunk_index);

CREATE INDEX IF NOT EXISTS idx_drawer_chunk_meta_by_drawer
  ON drawer_chunk_meta(drawer_rowid);


