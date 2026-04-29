-- Tabla virtual FTS5. 'id' no se indexa, solo sirve de JOIN key.
CREATE VIRTUAL TABLE IF NOT EXISTS fts_drawers USING fts5(id UNINDEXED, content);

-- Backfill inicial con la data actual
INSERT INTO fts_drawers (id, content) SELECT id, content FROM memory_drawers;

-- Triggers para mantener la tabla FTS en sync con cualquier mutación
CREATE TRIGGER IF NOT EXISTS fts_drawers_ai AFTER INSERT ON memory_drawers BEGIN
  INSERT INTO fts_drawers(id, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS fts_drawers_ad AFTER DELETE ON memory_drawers BEGIN
  DELETE FROM fts_drawers WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS fts_drawers_au AFTER UPDATE ON memory_drawers BEGIN
  DELETE FROM fts_drawers WHERE id = old.id;
  INSERT INTO fts_drawers(id, content) VALUES (new.id, new.content);
END;
