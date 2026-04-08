import { createLogger } from "../logging/logger.ts"
import { readChannelsConfig } from "./config.ts"
import { createTelegramPoller, type TelegramPoller } from "./telegramPoller.ts"
import type { MonolitoV2Runtime } from "../runtime/runtime.ts"

const logger = createLogger("channels")
let activePoller: TelegramPoller | null = null

export function startChannels(runtime: MonolitoV2Runtime) {
  const config = readChannelsConfig()
  process.stderr.write(`[ChannelManager] startChannels called. Telegram enabled: ${!!config.telegram?.enabled}\n`)

  if (config.telegram?.enabled && config.telegram.token) {
    logger.info("Iniciando integración de Telegram...")
    
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
