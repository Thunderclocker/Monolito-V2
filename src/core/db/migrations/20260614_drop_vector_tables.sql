-- Migration: 20260614_drop_vector_tables
-- Elimina las tablas vectoriales (sqlite-vec) y la cache de embeddings.
-- El recall semántico fue reemplazado por FTS5 (20260614_fts_memory.sql).
--
-- IMPORTANTE: Hacer backup de memory.sqlite antes de ejecutar.
-- Esta migración es IRREVERSIBLE.

DROP TABLE IF EXISTS vec_drawers;
DROP TABLE IF EXISTS vec_messages;
DROP TABLE IF EXISTS vec_drawer_chunks;
DROP TABLE IF EXISTS drawer_chunk_meta;
DROP TABLE IF EXISTS embedding_cache;
