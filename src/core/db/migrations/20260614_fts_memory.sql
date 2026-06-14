-- Migration: 20260614_fts_memory
-- Crea tablas FTS5 sobre messages y memory_drawers como reemplazo
-- del recall vectorial (vec_drawers / vec_messages).
-- Estas tablas usan "external content" para no duplicar datos;
-- los triggers las mantienen sincronizadas.

-- FTS5 sobre mensajes (búsqueda histórica por keyword)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize='unicode61'
);

-- FTS5 sobre memory_drawers (recall de hechos por keyword)
CREATE VIRTUAL TABLE IF NOT EXISTS drawers_fts USING fts5(
  content,
  memory_key,
  wing,
  room,
  content='memory_drawers',
  content_rowid='rowid',
  tokenize='unicode61'
);

-- Triggers para messages_fts
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Triggers para drawers_fts
CREATE TRIGGER IF NOT EXISTS drawers_fts_ai AFTER INSERT ON memory_drawers BEGIN
  INSERT INTO drawers_fts(rowid, content, memory_key, wing, room)
  VALUES (new.rowid, new.content, new.memory_key, new.wing, new.room);
END;

CREATE TRIGGER IF NOT EXISTS drawers_fts_ad AFTER DELETE ON memory_drawers BEGIN
  INSERT INTO drawers_fts(drawers_fts, rowid, content, memory_key, wing, room)
  VALUES ('delete', old.rowid, old.content, old.memory_key, old.wing, old.room);
END;

CREATE TRIGGER IF NOT EXISTS drawers_fts_au AFTER UPDATE ON memory_drawers BEGIN
  INSERT INTO drawers_fts(drawers_fts, rowid, content, memory_key, wing, room)
  VALUES ('delete', old.rowid, old.content, old.memory_key, old.wing, old.room);
  INSERT INTO drawers_fts(rowid, content, memory_key, wing, room)
  VALUES (new.rowid, new.content, new.memory_key, new.wing, new.room);
END;
