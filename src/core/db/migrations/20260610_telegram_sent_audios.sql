-- 2026-06-10: Track every audio/voice Monolito sent to Telegram.
--
-- Mirrors telegram_sent_photos (see 20260606_telegram_sent_photos.sql).
-- Previously, once TelegramSendVoice returned ok to the LLM, the
-- `file_id` and `message_id` were only echoed in the tool result for
-- that turn. The model had no way to ask "what was the last audio I
-- sent to this chat?" in a later turn, which made post-send
-- re-verification impossible.
--
-- The fast dedupe path lives in a JSON file maintained by
-- `markAudioAsSent` / `isAudioAlreadySent` in tools/internal.ts (same
-- pattern as the photos). This DB table is the durable audit log
-- so the model can query recent sent audio with `TelegramGetRecentAudios`
-- (future) and verify post-send.
--
-- Schema notes:
-- - kind distinguishes voice notes (TelegramSendVoice) from audio files
--   (TelegramSendAudio). The runtime can query both with a single
--   chat_id filter.
-- - duration_seconds and file_size_bytes are stored so the model can
--   answer "cuánto pesaba el último audio" without re-uploading.
-- - chat_id + sent_at DESC index mirrors the photos one.

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
