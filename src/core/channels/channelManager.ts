import { createLogger } from "../logging/logger.ts"
import { readChannelsConfig } from "./config.ts"
import { createTelegramPoller, type TelegramMessage, type TelegramPoller } from "./telegramPoller.ts"
import type { MonolitoV2Runtime } from "../runtime/runtime.ts"

const logger = createLogger("channels")
let activePoller: TelegramPoller | null = null

const TELEGRAM_BOT_COMMANDS = [
  { command: "help", description: "Show available commands" },
  { command: "status", description: "Show current session status" },
  { command: "sessions", description: "List active sessions" },
  { command: "history", description: "Show recent session history" },
  { command: "cost", description: "Show token and cost summary" },
  { command: "model", description: "Show current model configuration" },
  { command: "doctor", description: "Run a quick health check" },
  { command: "update", description: "Fetch updates and restart daemon" },
  { command: "websearch", description: "Show web search mode" },
  { command: "new", description: "Start a fresh session" },
] as const

async function registerTelegramCommands(token: string) {
  const response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: TELEGRAM_BOT_COMMANDS,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`setMyCommands failed: ${response.status}${body ? ` - ${body}` : ""}`)
  }

  const payload = await response.json() as { ok?: boolean; description?: string }
  if (!payload.ok) {
    throw new Error(payload.description || "Telegram rejected setMyCommands")
  }
}

function normalizeTelegramCommand(text: string) {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null

  const [head, ...rest] = trimmed.split(/\s+/)
  const normalizedHead = head.replace(/^\/([^@\s]+)@[\w_]+$/, "/$1")
  return [normalizedHead, ...rest].join(" ").trim()
}

function escapeXml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
}

function buildTelegramInboundText(msg: TelegramMessage | undefined) {
  if (!msg) return null
  const text = msg.text?.trim() || msg.caption?.trim() || ""
  const slashCommand = normalizeTelegramCommand(text)
  if (slashCommand && !msg.photo && !msg.document && !msg.audio && !msg.video && !msg.voice && !msg.video_note) {
    return slashCommand
  }

  const parts: string[] = [`<channel source="telegram" chat_id="${msg.chat.id}">`]
  if (text) {
    parts.push(`<text>${escapeXml(text)}</text>`)
  }

  if (msg.photo?.length) {
    const largest = [...msg.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]
    if (largest) {
      parts.push(`<attachment kind="photo" file_id="${largest.file_id}" width="${largest.width}" height="${largest.height}" />`)
    }
  }
  if (msg.document) {
    parts.push(
      `<attachment kind="document" file_id="${msg.document.file_id}" file_name="${escapeXml(msg.document.file_name ?? "")}" mime_type="${escapeXml(msg.document.mime_type ?? "")}" />`,
    )
  }
  if (msg.audio) {
    parts.push(
      `<attachment kind="audio" file_id="${msg.audio.file_id}" title="${escapeXml(msg.audio.title ?? "")}" performer="${escapeXml(msg.audio.performer ?? "")}" mime_type="${escapeXml(msg.audio.mime_type ?? "")}" />`,
    )
  }
  if (msg.video) {
    parts.push(
      `<attachment kind="video" file_id="${msg.video.file_id}" mime_type="${escapeXml(msg.video.mime_type ?? "")}" width="${msg.video.width}" height="${msg.video.height}" />`,
    )
  }
  if (msg.voice) {
    parts.push(`<attachment kind="voice" file_id="${msg.voice.file_id}" mime_type="${escapeXml(msg.voice.mime_type ?? "")}" />`)
  }
  if (msg.video_note) {
    parts.push(`<attachment kind="video_note" file_id="${msg.video_note.file_id}" length="${msg.video_note.length}" />`)
  }

  parts.push("</channel>")
  return parts.join("\n")
}

export function startChannels(runtime: MonolitoV2Runtime) {
  const config = readChannelsConfig()
  process.stderr.write(`[ChannelManager] startChannels called. Telegram enabled: ${!!config.telegram?.enabled}\n`)

  if (config.telegram?.enabled && config.telegram.token) {
    logger.info("Iniciando integración de Telegram...")
    void registerTelegramCommands(config.telegram.token)
      .then(() => {
        logger.info("Comandos de Telegram registrados")
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`No se pudieron registrar los comandos sugeridos de Telegram: ${message}`)
      })
    
    activePoller = createTelegramPoller(config.telegram.token, {
      onUpdate: async (update) => {
        const msg = update.message || update.channel_post
        if (!msg) return
        if (msg.from?.is_bot) {
          logger.debug(`Ignorando mensaje del propio bot o de otro bot en Telegram chat ${msg.chat.id}`)
          return
        }
        
        const chatId = msg.chat.id
        
        // Autorización
        if (config.telegram?.allowedChats && config.telegram.allowedChats.length > 0) {
          if (!config.telegram.allowedChats.includes(chatId)) {
            logger.warn(`Mensaje de Telegram bloqueado (chat no autorizado): ${chatId}`)
            return
          }
        }
        
        const sessionId = `telegram-${chatId}`
        const inboundText = buildTelegramInboundText(msg)
        if (!inboundText) return
        
        logger.debug(`Recibido mensaje de Telegram [${chatId}]`)
        
        // Asegurar que la sesión exista antes de enviar el mensaje
        try {
          runtime.ensureSession(sessionId, `Telegram ${chatId}`)
          await runtime.processMessage(sessionId, inboundText)
        } catch (error) {
          const err = error as Error & { code?: string }
          const detail = err.code ? ` code=${err.code}` : ""
          logger.error(`Error procesando mensaje de Telegram en sesión ${sessionId}${detail}: ${err.message}`)
          if (err.stack) logger.debug(`Stack: ${err.stack}`)
        }
      },
      onError: (error) => {
        logger.error("Error en poller de Telegram", error)
      }
    })
    
    activePoller.start()
  }
}

export function stopChannels() {
  if (activePoller) {
    logger.info("Deteniendo integración de Telegram...")
    activePoller.stop()
    activePoller = null
  }
}
