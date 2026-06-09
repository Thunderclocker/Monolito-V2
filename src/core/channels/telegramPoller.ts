import { createLogger } from "../logging/logger.ts"

const logger = createLogger("telegram")
const POLLING_INTERVAL_MS = 1000

const MAX_RECONNECT_ATTEMPTS = 5
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000

function isTelegramConflictError(error: Error): boolean {
  const message = error.message.toLowerCase()
  return message.includes("409") && message.includes("conflict")
}

function isRetriableTelegramNetworkError(error: Error): boolean {
  const message = error.message.toLowerCase()
  // undici wraps low-level socket errors with "fetch failed" — inspect the
  // cause chain to see the actual system code. Without this, ECONNRESET /
  // ENETUNREACH / EAI_AGAIN (DNS hiccup, transient wifi drop) fall into the
  // generic reconnect-counter path and the poller gives up too early.
  const causeCode = (error as { cause?: { code?: string } }).cause?.code?.toLowerCase() ?? ""
  const causeMessage = (error as { cause?: { message?: string } }).cause?.message?.toLowerCase() ?? ""
  const undiciTransientCodes = [
    "econnreset",
    "enotfound",
    "enetunreach",
    "eai_again",
    "etimedout",
    "epipe",
    "econnaborted",
  ]
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    message.includes("502") ||
    message.includes("bad gateway") ||
    // undici fetch failed with a transient socket cause
    (message.includes("fetch failed") &&
      (undiciTransientCodes.some(c => causeCode === c || causeMessage.includes(c)) ||
        causeCode.length > 0)) ||
    undiciTransientCodes.some(c => message.includes(c) || causeCode === c)
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

/**
 * Optional persistence hooks. The poller will call persistRawUpdate BEFORE
 * invoking onUpdate, and markProcessed AFTER onUpdate resolves. Both are
 * best-effort: a persistence failure is logged at debug level and does not
 * stop the poll. This is the durability mechanism that survives a daemon
 * crash mid-process.
 */
export interface TelegramPollerPersistenceHooks {
  persistRawUpdate?: (updateId: number, chatId: number | null, rawJson: string) => void
  markProcessed?: (updateId: number) => void
}

export function createTelegramPoller(
  token: string,
  callbacks: TelegramPollerCallbacks,
  options: TelegramPollerPersistenceHooks = {},
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
          // Persist the raw update BEFORE calling onUpdate. If the daemon
          // crashes between the persist and the processing, the update is
          // still in the table; the next startup can replay it (Telegram
          // also re-delivers on re-poll since offset is not advanced until
          // processing completes).
          if (options.persistRawUpdate) {
            try {
              const chatId = update.message?.chat?.id
                ?? update.edited_message?.chat?.id
                ?? update.channel_post?.chat?.id
                ?? update.callback_query?.message?.chat?.id
                ?? null
              options.persistRawUpdate(update.update_id, chatId, JSON.stringify(update))
            } catch (err) {
              logger.debug(`[Telegram] Failed to persist raw update ${update.update_id}: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          try {
            await callbacks.onUpdate(update)
            // Mark processed only after onUpdate resolves without throwing.
            // If it throws, the offset is still advanced (Telegram won't
            // re-deliver this update_id) but the raw table preserves the
            // payload for forensic review.
            if (options.markProcessed) {
              options.markProcessed(update.update_id)
            }
          } catch (err) {
            logger.error(`[Telegram] onUpdate failed for update_id ${update.update_id}: ${err instanceof Error ? err.message : String(err)}`)
            // Re-throw so the existing error handling kicks in and the
            // poller backs off. The update is in the raw table, so we can
            // add a recovery path later.
            throw err
          }
          offset = update.update_id + 1
        }
      }

      // Reset backoff on successful poll
      reconnectAttempts = 0
      return POLLING_INTERVAL_MS

    } catch (error) {
      if (stopped) return POLLING_INTERVAL_MS

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
    // Sequential polling - each poll completes before the next starts
    // This prevents duplicate messages from overlapping requests
    async function sequentialPoll(): Promise<void> {
      let networkBackoffMs = POLLING_INTERVAL_MS
      try {
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
              logger.error("Error no manejado en Telegram poller", err)
              callbacks.onError(err)
              reconnectAttempts++
              nextDelay = Math.min(
                INITIAL_BACKOFF_MS * Math.pow(2, Math.max(reconnectAttempts - 1, 0)),
                MAX_BACKOFF_MS,
              )
            }
          }
          if (stopped) break
          await new Promise(resolve => setTimeout(resolve, typeof nextDelay === "number" ? nextDelay : POLLING_INTERVAL_MS))
        }
      } catch (error) {
        logger.error("Error no manejado en Telegram poller", error)
        callbacks.onError(error instanceof Error ? error : new Error(String(error)))
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
