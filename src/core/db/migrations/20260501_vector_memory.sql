DROP TRIGGER IF EXISTS fts_drawers_ai;
DROP TRIGGER IF EXISTS fts_drawers_ad;
DROP TRIGGER IF EXISTS fts_drawers_au;
DROP TABLE IF EXISTS fts_drawers;

DROP TABLE IF EXISTS vec_drawers;
DROP TABLE IF EXISTS vec_messages;

CREATE VIRTUAL TABLE IF NOT EXISTS vec_drawers USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[768]
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(
  id INTEGER PRIMARY KEY,
  embedding float[768]
);
