type TelegramApi = (token: string, method: string, body: Record<string, unknown>) => Promise<unknown>

async function defaultTelegramApi(token: string, method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await response.json() as { ok: boolean; result?: unknown; description?: string }
  if (!data.ok) throw new Error(data.description ?? `Telegram API error (${response.status})`)
  return data.result
}

const TELEGRAM_MAX_TEXT = 4096
const EDIT_DEBOUNCE_MS = 450

function truncateTelegramPreview(text: string) {
  if (text.length <= TELEGRAM_MAX_TEXT) return text
  return `${text.slice(0, TELEGRAM_MAX_TEXT - 1)}…`
}

export class TelegramStreamDelivery {
  private buffer = ""
  private messageId: number | null = null
  private lastEditAt = 0
  private editTimer: ReturnType<typeof setTimeout> | null = null
  private finished = false
  private token: string
  private chatId: number
  private telegramApi: TelegramApi

  constructor(token: string, chatId: number, telegramApi: TelegramApi = defaultTelegramApi) {
    this.token = token
    this.chatId = chatId
    this.telegramApi = telegramApi
  }

  isActive() {
    return !this.finished && (this.messageId !== null || this.buffer.length > 0)
  }

  onDelta(text: string) {
    if (this.finished || !text) return
    this.buffer += text
    if (this.editTimer) return
    this.editTimer = setTimeout(() => {
      this.editTimer = null
      void this.flush(false)
    }, EDIT_DEBOUNCE_MS)
  }

  private async ensureMessage() {
    if (this.messageId !== null) return
    const preview = truncateTelegramPreview(this.buffer.trim() || "…")
    const result = await this.telegramApi(this.token, "sendMessage", {
      chat_id: this.chatId,
      text: preview,
    }) as { message_id?: number }
    this.messageId = result.message_id ?? null
  }

  private async flush(final: boolean) {
    if (this.finished || !this.buffer.trim()) return
    const now = Date.now()
    if (!final && now - this.lastEditAt < EDIT_DEBOUNCE_MS) return
    await this.ensureMessage()
    if (this.messageId === null) return
    const preview = truncateTelegramPreview(this.buffer.trim())
    await this.telegramApi(this.token, "editMessageText", {
      chat_id: this.chatId,
      message_id: this.messageId,
      text: preview,
    }).catch(() => {})
    this.lastEditAt = now
  }

  async finish(finalText: string) {
    if (this.finished) return false
    this.finished = true
    if (this.editTimer) {
      clearTimeout(this.editTimer)
      this.editTimer = null
    }
    const text = finalText.trim()
    if (!text) return false
    if (this.messageId === null) {
      await this.telegramApi(this.token, "sendMessage", {
        chat_id: this.chatId,
        text,
      })
      return true
    }
    if (text.length > TELEGRAM_MAX_TEXT) {
      await this.telegramApi(this.token, "editMessageText", {
        chat_id: this.chatId,
        message_id: this.messageId,
        text: truncateTelegramPreview(text),
      }).catch(() => {})
      const remainder = text.slice(TELEGRAM_MAX_TEXT - 1)
      if (remainder.trim()) {
        await this.telegramApi(this.token, "sendMessage", {
          chat_id: this.chatId,
          text: remainder.trim(),
        })
      }
      return true
    }
    await this.telegramApi(this.token, "editMessageText", {
      chat_id: this.chatId,
      message_id: this.messageId,
      text,
    }).catch(async () => {
      await this.telegramApi(this.token, "sendMessage", {
        chat_id: this.chatId,
        text,
      })
    })
    return true
  }
}

export function createTelegramStreamDelivery(token: string, chatId: number) {
  return new TelegramStreamDelivery(token, chatId)
}
