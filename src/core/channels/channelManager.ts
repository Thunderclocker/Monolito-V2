import { createLogger } from "../logging/logger.ts"
import { readChannelsConfig, writeChannelsConfig } from "./config.ts"
import { readWebSearchConfig, writeWebSearchConfig } from "../websearch/config.ts"
import { createTelegramPoller, type TelegramCallbackQuery, type TelegramMessage, type TelegramPoller } from "./telegramPoller.ts"
import type { MonolitoV2Runtime } from "../runtime/runtime.ts"

const logger = createLogger("channels")
let activePoller: TelegramPoller | null = null
const pendingTelegramInputs = new Map<number, { kind: "channels-token" | "channels-chats" | "websearch-test" }>()

const TELEGRAM_BOT_COMMANDS = [
  { command: "help", description: "Show available commands" },
  { command: "status", description: "Show current session status" },
  { command: "sessions", description: "List active sessions" },
  { command: "history", description: "Show recent session history" },
  { command: "cost", description: "Show token and cost summary" },
  { command: "compact", description: "Compact current session" },
  { command: "model", description: "Show current model configuration" },
  { command: "channels", description: "Configure Telegram channel settings" },
  { command: "config", description: "Show or set configuration" },
  { command: "doctor", description: "Run a quick health check" },
  { command: "adult", description: "Toggle adult mode" },
  { command: "update", description: "Fetch updates and restart daemon" },
  { command: "tts", description: "Manage local TTS service" },
  { command: "websearch", description: "Configure web search mode" },
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

type TelegramInlineButton = { text: string; callback_data: string }

async function telegramApi(token: string, method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const data = await response.json() as { ok: boolean; result?: unknown; description?: string }
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description ?? response.status}`)
  }
  return data.result
}

async function sendTelegramMenu(
  token: string,
  chatId: number,
  text: string,
  buttons: TelegramInlineButton[][],
) {
  return await telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: buttons },
  })
}

async function editTelegramMenu(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  buttons: TelegramInlineButton[][],
) {
  return await telegramApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: buttons },
  })
}

async function answerTelegramCallback(token: string, callbackId: string, text?: string) {
  await telegramApi(token, "answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  }).catch(() => {})
}

function parseAllowedChats(raw: string) {
  const ids = raw.split(",").map(item => item.trim()).filter(Boolean).map(Number)
  const invalid = ids.filter(item => !Number.isFinite(item) || item === 0)
  return { ids, invalid }
}

function buildWebSearchMenuText() {
  const config = readWebSearchConfig()
  return [
    "Web Search",
    `Modo activo: ${config.provider}`,
    "",
    "Elegí el método de búsqueda web.",
    "Si elegís SearxNG, se despliega/inicia automáticamente si hace falta.",
  ].join("\n")
}

function buildWebSearchMenuButtons(): TelegramInlineButton[][] {
  return [
    [
      { text: "Default", callback_data: "ws:set:default" },
      { text: "SearxNG", callback_data: "ws:set:searxng" },
    ],
    [
      { text: "List", callback_data: "ws:act:list" },
      { text: "Stop", callback_data: "ws:act:stop" },
      { text: "Refresh", callback_data: "ws:show" },
    ],
    [
      { text: "Remove", callback_data: "ws:act:remove" },
      { text: "Clean", callback_data: "ws:act:clean" },
      { text: "Test", callback_data: "ws:act:test" },
    ],
  ]
}

function buildChannelsMenuText() {
  const config = readChannelsConfig()
  const telegram = config.telegram ?? { token: "", enabled: false, allowedChats: [] }
  return [
    "Channels / Telegram",
    `Enabled: ${telegram.enabled ? "yes" : "no"}`,
    `Token: ${telegram.token ? "configured" : "missing"}`,
    `Allowed chats: ${telegram.allowedChats.length > 0 ? telegram.allowedChats.join(", ") : "(all chats allowed)"}`,
    "",
    "Usá los botones o elegí una opción que espere tu próximo mensaje.",
  ].join("\n")
}

function buildChannelsMenuButtons(): TelegramInlineButton[][] {
  return [
    [
      { text: "On/Off", callback_data: "ch:toggle" },
      { text: "Set Token", callback_data: "ch:token" },
      { text: "Set Chats", callback_data: "ch:chats" },
    ],
    [
      { text: "Clear Chats", callback_data: "ch:clear" },
      { text: "Refresh", callback_data: "ch:show" },
    ],
  ]
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

async function handleWebSearchCallback(token: string, callback: TelegramCallbackQuery) {
  const data = (callback.data ?? "").trim()
  const message = callback.message
  if (!message) return false
  const chatId = message.chat.id
  const messageId = message.message_id

  if (data === "ws:show") {
    await editTelegramMenu(token, chatId, messageId, buildWebSearchMenuText(), buildWebSearchMenuButtons())
    return true
  }

  if (data.startsWith("ws:set:")) {
    const provider = data.slice("ws:set:".length)
    if (provider === "default" || provider === "searxng") {
      writeWebSearchConfig({ provider })
      await editTelegramMenu(
        token,
        chatId,
        messageId,
        `${buildWebSearchMenuText()}\n\nModo cambiado a: ${provider}${provider === "searxng" ? "\n\nActivando SearxNG..." : ""}`,
        buildWebSearchMenuButtons(),
      )
      if (provider === "searxng") {
        return "/websearch searxng"
      }
      return true
    }
  }

  if (data === "ws:act:test") {
    pendingTelegramInputs.set(chatId, { kind: "websearch-test" })
    await editTelegramMenu(
      token,
      chatId,
      messageId,
      `${buildWebSearchMenuText()}\n\nMandá tu próximo mensaje con la query a probar en SearxNG.`,
      buildWebSearchMenuButtons(),
    )
    return true
  }

  const command =
    data === "ws:act:list" ? "/websearch searxng list" :
    data === "ws:act:stop" ? "/websearch searxng stop" :
    data === "ws:act:remove" ? "/websearch searxng remove" :
    data === "ws:act:clean" ? "/websearch searxng clean" :
    null

  if (!command) return false
  return command
}

async function handleChannelsCallback(token: string, callback: TelegramCallbackQuery) {
  const data = (callback.data ?? "").trim()
  const message = callback.message
  if (!message) return false
  const chatId = message.chat.id
  const messageId = message.message_id
  const config = readChannelsConfig()
  const telegram = config.telegram ?? { token: "", enabled: false, allowedChats: [] }

  if (data === "ch:show") {
    await editTelegramMenu(token, chatId, messageId, buildChannelsMenuText(), buildChannelsMenuButtons())
    return true
  }

  if (data === "ch:toggle") {
    config.telegram = { ...telegram, enabled: !telegram.enabled }
    writeChannelsConfig(config)
    await editTelegramMenu(
      token,
      chatId,
      messageId,
      `${buildChannelsMenuText()}\n\nTelegram ${config.telegram.enabled ? "habilitado" : "deshabilitado"}.`,
      buildChannelsMenuButtons(),
    )
    return "RESTART"
  }

  if (data === "ch:clear") {
    config.telegram = { ...telegram, allowedChats: [] }
    writeChannelsConfig(config)
    await editTelegramMenu(
      token,
      chatId,
      messageId,
      `${buildChannelsMenuText()}\n\nLista de chats autorizados limpiada.`,
      buildChannelsMenuButtons(),
    )
    return "RESTART"
  }

  if (data === "ch:token") {
    pendingTelegramInputs.set(chatId, { kind: "channels-token" })
    await editTelegramMenu(
      token,
      chatId,
      messageId,
      `${buildChannelsMenuText()}\n\nMandá tu próximo mensaje con el token de Telegram.`,
      buildChannelsMenuButtons(),
    )
    return true
  }

  if (data === "ch:chats") {
    pendingTelegramInputs.set(chatId, { kind: "channels-chats" })
    await editTelegramMenu(
      token,
      chatId,
      messageId,
      `${buildChannelsMenuText()}\n\nMandá tu próximo mensaje con los chat IDs separados por coma.`,
      buildChannelsMenuButtons(),
    )
    return true
  }

  return false
}

export function startChannels(runtime: MonolitoV2Runtime, options?: { onRestartRequested?: () => void }) {
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
        if (update.callback_query) {
          const callback = update.callback_query
          const callbackMessage = callback.message
          const chatId = callbackMessage?.chat.id ?? callback.from.id
          if (config.telegram?.allowedChats && config.telegram.allowedChats.length > 0) {
            if (!config.telegram.allowedChats.includes(chatId)) {
              logger.warn(`Callback de Telegram bloqueado (chat no autorizado): ${chatId}`)
              return
            }
          }

          await answerTelegramCallback(config.telegram.token, callback.id)

          try {
            const websearchResult = await handleWebSearchCallback(config.telegram.token, callback)
            if (websearchResult) {
              if (typeof websearchResult === "string") {
                const sessionId = `telegram-${chatId}`
                runtime.ensureSession(sessionId, `Telegram ${chatId}`)
                await runtime.processMessage(sessionId, websearchResult)
              }
              return
            }

            const channelResult = await handleChannelsCallback(config.telegram.token, callback)
            if (channelResult) {
              if (channelResult === "RESTART") {
                options?.onRestartRequested?.()
              }
              return
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error(`Error procesando callback de Telegram en chat ${chatId}: ${message}`)
          }
          return
        }

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
        const normalized = normalizeTelegramCommand(msg.text?.trim() || msg.caption?.trim() || "")

        const pending = pendingTelegramInputs.get(chatId)
        if (pending) {
          pendingTelegramInputs.delete(chatId)
          try {
            if (pending.kind === "channels-token") {
              const token = (msg.text ?? msg.caption ?? "").trim()
              if (!token) {
                await sendTelegramMenu(config.telegram.token, chatId, "Token vacío. Probá /channels de nuevo.", buildChannelsMenuButtons())
                return
              }
              const nextConfig = readChannelsConfig()
              const telegram = nextConfig.telegram ?? { token: "", enabled: false, allowedChats: [] }
              nextConfig.telegram = { ...telegram, token, enabled: true }
              writeChannelsConfig(nextConfig)
              await sendTelegramMenu(config.telegram.token, chatId, "Token guardado correctamente.", buildChannelsMenuButtons())
              options?.onRestartRequested?.()
              return
            }
            if (pending.kind === "channels-chats") {
              const raw = (msg.text ?? msg.caption ?? "").trim()
              const { ids, invalid } = parseAllowedChats(raw)
              if (invalid.length > 0) {
                await sendTelegramMenu(config.telegram.token, chatId, `IDs inválidos: ${invalid.join(", ")}`, buildChannelsMenuButtons())
                return
              }
              const nextConfig = readChannelsConfig()
              const telegram = nextConfig.telegram ?? { token: "", enabled: false, allowedChats: [] }
              nextConfig.telegram = { ...telegram, allowedChats: ids }
              writeChannelsConfig(nextConfig)
              await sendTelegramMenu(config.telegram.token, chatId, `Chats autorizados guardados: ${ids.join(", ")}`, buildChannelsMenuButtons())
              options?.onRestartRequested?.()
              return
            }
            if (pending.kind === "websearch-test") {
              const query = (msg.text ?? msg.caption ?? "").trim()
              if (!query) {
                await sendTelegramMenu(config.telegram.token, chatId, "Query vacía. Probá /websearch de nuevo.", buildWebSearchMenuButtons())
                return
              }
              const sessionId = `telegram-${chatId}`
              runtime.ensureSession(sessionId, `Telegram ${chatId}`)
              await runtime.processMessage(sessionId, `/websearch searxng test ${query}`)
              return
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error(`Error procesando input pendiente de Telegram en chat ${chatId}: ${message}`)
            return
          }
        }

        if (normalized === "/websearch") {
          await sendTelegramMenu(config.telegram.token, chatId, buildWebSearchMenuText(), buildWebSearchMenuButtons())
          return
        }

        if (normalized === "/channels") {
          await sendTelegramMenu(config.telegram.token, chatId, buildChannelsMenuText(), buildChannelsMenuButtons())
          return
        }

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
