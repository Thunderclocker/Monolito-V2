-- 2026-06-06: Track every photo Monolito sent to Telegram.
--
-- Previously, once TelegramSendPhoto returned ok to the LLM, the
-- `file_id` and `message_id` were echoed only in the tool result for
-- that turn. The model had no way to ask "what was the last photo I
-- sent to this chat?" in a later turn, which made post-send verification
-- (e.g. "verifica la última foto que te mandé") impossible.
--
-- This table is the durable store. TelegramSendPhoto writes here on
-- every successful delivery; TelegramGetRecentPhotos reads here.
--
-- Schema notes:
-- - file_id is the Telegram-side identifier returned by the
--   sendPhoto API. It is the key that VisionAnalyze accepts to
--   re-download and re-analyze the photo from Telegram servers.
-- - message_id is the message identifier in the chat (useful for
--   the model to reference in conversation: "el mensaje 12345").
-- - local_path is the local cache path used at send time, so the
--   model can also pass `path=` to VisionAnalyze without going
--   through Telegram's download endpoint.
-- - caption is stored so the model can disambiguate when the user
--   asks "the one I sent with the Eiffel Tower caption".
-- - chat_id + sent_at DESC index supports the most common query:
--   "last N photos sent to THIS chat".

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
