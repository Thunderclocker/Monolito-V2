import { createLogger } from "../logging/logger.ts"
import { readChannelsConfig } from "./config.ts"
import { createTelegramPoller, type TelegramPoller } from "./telegramPoller.ts"
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
        // Ignorar si no es mensaje de texto
        const msg = update.message || update.channel_post
        if (!msg || !msg.text) return
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
        const wrappedText = `<channel source="telegram" chat_id="${chatId}">\n${msg.text}\n</channel>`
        
        logger.debug(`Recibido mensaje de Telegram [${chatId}]: ${msg.text}`)
        
        // Asegurar que la sesión exista antes de enviar el mensaje
        try {
          runtime.ensureSession(sessionId, `Telegram ${chatId}`)
          await runtime.processMessage(sessionId, wrappedText)
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
