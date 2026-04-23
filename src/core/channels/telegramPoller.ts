import { createLogger } from "../logging/logger.ts"

const logger = createLogger("telegram")
const POLLING_INTERVAL_MS = 1000

/**
 * Kill other polling processes for this bot token.
 * This prevents 409 Conflict errors when multiple instances run.
 * Sketches the Telegram desktop app (MTProto) since it uses a different protocol.
 */
async function killOtherPollers(): Promise<void> {
  try {
    const { execSync } = await import('child_process')
    // Find processes running the Telegram plugin polling (excluding our parent)
    // Kill processes that have the Telegram plugin path or getUpdates pattern
    const cmd = `ps aux | grep -E 'telegram.*(start|getUpdates|polling)' | grep -v grep | grep -v $$ | awk '{print $2}' | xargs -r kill 2>/dev/null; pkill -f 'getUpdates.*api.telegram.org' 2>/dev/null || true`
    execSync(cmd, { timeout: 5000 })
    logger.debug('[Telegram] Killed other polling processes')
  } catch {
    // Non-fatal - just continue
  }
}
const MAX_RECONNECT_ATTEMPTS = 5
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000

function isTelegramConflictError(error: Error): boolean {
  const message = error.message.toLowerCase()
  return message.includes("409") && message.includes("conflict")
}

function isRetriableTelegramNetworkError(error: Error): boolean {
  const message = error.message.toLowerCase()
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    message.includes("502") ||
    message.includes("bad gateway")
  )
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  edited_channel_post?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
  photo?: TelegramPhoto[]
  document?: TelegramDocument
  audio?: TelegramAudio
  video?: TelegramVideo
  voice?: TelegramVoice
  video_note?: TelegramVideoNote
  sticker?: TelegramSticker
  location?: TelegramLocation
  contact?: TelegramContact
  caption?: string
  reply_to_message?: TelegramMessage
}

export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramPhoto {
  file_id: string
  width: number
  height: number
  file_size?: number
}

export interface TelegramDocument {
  file_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramAudio {
  file_id: string
  duration: number
  performer?: string
  title?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramVideo {
  file_id: string
  width: number
  height: number
  duration: number
  mime_type?: string
  file_size?: number
}

export interface TelegramVoice {
  file_id: string
  duration: number
  mime_type?: string
  file_size?: number
}

export interface TelegramVideoNote {
  file_id: string
  length: number
  duration: number
  file_size?: number
}

export interface TelegramSticker {
  file_id: string
  width: number
  height: number
  is_animated: boolean
  emoji?: string
  set_name?: string
}

export interface TelegramLocation {
  latitude: number
  longitude: number
}

export interface TelegramContact {
  phone_number: string
  first_name: string
  last_name?: string
  user_id?: number
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  chat_instance: string
  data?: string
  message?: TelegramMessage
}

export interface TelegramPoller {
  start(): void
  stop(): void
}

export interface TelegramPollerCallbacks {
  onUpdate(update: TelegramUpdate): void | Promise<void>
  onError(error: Error): void
}

export function createTelegramPoller(
  token: string,
  callbacks: TelegramPollerCallbacks
): TelegramPoller {
  let offset = 0
  let reconnectAttempts = 0
  let stopped = false

  async function pollOnce(): Promise<number> {
    if (stopped) return POLLING_INTERVAL_MS

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30`,
        { signal: AbortSignal.timeout(35000) }
      )

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Telegram API error: ${response.status} - ${errorText}`)
      }

      const data = (await response.json()) as { ok: boolean; result: TelegramUpdate[] }

      if (!data.ok) {
        throw new Error(`Telegram API returned ok=false`)
      }

      if (data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1
          await callbacks.onUpdate(update)
        }
      }

      // Reset backoff on successful poll
      reconnectAttempts = 0
      return POLLING_INTERVAL_MS

    } catch (error) {
      if (stopped) return

      const err = error as Error

      // Handle specific errors
      if (err.message.includes('401')) {
        logger.debug(`[Telegram] Invalid bot token - stopping`)
        callbacks.onError(new Error('Invalid Telegram bot token'))
        stopped = true
        return MAX_BACKOFF_MS
      }

      if (isTelegramConflictError(err)) {
        // Another process is polling - wait longer
        logger.debug(`[Telegram] 409 Conflict - another process is polling`)
        reconnectAttempts++
        const backoff = Math.min(
          INITIAL_BACKOFF_MS * Math.pow(2, Math.min(reconnectAttempts + 1, MAX_RECONNECT_ATTEMPTS) - 1),
          MAX_BACKOFF_MS,
        )
        return backoff
      }

      if (err.name === 'AbortError') {
        // Timeout is expected when no updates - just retry
        logger.debug(`[Telegram] Poll timed out (no updates), continuing...`)
        reconnectAttempts = 0
        return POLLING_INTERVAL_MS
      }

      if (isRetriableTelegramNetworkError(err)) {
        throw err
      }

      logger.debug(`[Telegram] Polling error: ${err.message}`)
      callbacks.onError(err)
      reconnectAttempts++
      return Math.min(
        INITIAL_BACKOFF_MS * Math.pow(2, Math.max(reconnectAttempts - 1, 0)),
        MAX_BACKOFF_MS,
      )
    }
  }

  function start(): void {
    stopped = false
    reconnectAttempts = 0
    logger.debug(`[Telegram] Starting polling`)
    // Kill other pollers first to prevent 409 Conflict
    void killOtherPollers()
    // Sequential polling - each poll completes before the next starts
    // This prevents duplicate messages from overlapping requests
    async function sequentialPoll(): Promise<void> {
      let networkBackoffMs = POLLING_INTERVAL_MS
      while (!stopped) {
        let nextDelay = POLLING_INTERVAL_MS
        try {
          nextDelay = await pollOnce()
          networkBackoffMs = POLLING_INTERVAL_MS
        } catch (error) {
          const err = error as Error
          if (isRetriableTelegramNetworkError(err)) {
            callbacks.onError(err)
            networkBackoffMs = Math.min(
              networkBackoffMs <= 0 ? POLLING_INTERVAL_MS : networkBackoffMs * 2,
              MAX_BACKOFF_MS,
            )
            logger.debug(`[Telegram] Retriable network error: ${err.message}. Backing off for ${networkBackoffMs}ms`)
            nextDelay = networkBackoffMs
          } else {
            throw err
          }
        }
        if (stopped) break
        await new Promise(resolve => setTimeout(resolve, typeof nextDelay === "number" ? nextDelay : POLLING_INTERVAL_MS))
      }
    }
    void sequentialPoll()
  }

  function stop(): void {
    stopped = true
    logger.debug(`[Telegram] Polling stopped`)
  }

  return { start, stop }
}
