import { createLogger } from "../logging/logger.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readChannelsConfig, writeChannelsConfig } from "./config.ts"
import { readWebSearchConfig, writeWebSearchConfig } from "../websearch/config.ts"
import { createTelegramPoller, type TelegramCallbackQuery, type TelegramMessage, type TelegramPoller } from "./telegramPoller.ts"
import type { MonolitoV2Runtime } from "../runtime/runtime.ts"
import { ensureDirs } from "../ipc/protocol.ts"
import { deployManagedSttContainer, normalizeSttConfig, transcribeManagedAudioFile } from "../stt/managed.ts"

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
  { command: "stt", description: "Manage local STT service" },
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

async function sendTelegramText(token: string, chatId: number, text: string) {
  await telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text,
  })
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
    `Active mode: ${config.provider}`,
    "",
    "Choose the web search method.",
    "If you choose SearxNG, it is deployed/started automatically when needed.",
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
    "Use the buttons or pick an option that waits for your next message.",
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

async function downloadTelegramFile(token: string, fileId: string, rootDir: string, filenamePrefix: string) {
  const fileInfo = await telegramApi(token, "getFile", { file_id: fileId }) as { file_path?: string }
  if (!fileInfo.file_path) throw new Error("Telegram did not return file_path for this file_id.")
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Failed to download Telegram file: HTTP ${response.status}`)
  const paths = ensureDirs(rootDir)
  const downloadsDir = join(paths.scratchpadDir, "telegram-downloads")
  mkdirSync(downloadsDir, { recursive: true })
  const originalName = fileInfo.file_path.split("/").at(-1) ?? fileId
  const extension = originalName.includes(".") ? `.${originalName.split(".").at(-1)}` : ""
  const localPath = join(downloadsDir, `${filenamePrefix}${extension}`)
  writeFileSync(localPath, Buffer.from(await response.arrayBuffer()))
  return localPath
}

async function maybeTranscribeTelegramAudio(token: string, rootDir: string, msg: TelegramMessage | undefined) {
  if (!msg?.audio && !msg?.voice) return null
  const fileId = msg.voice?.file_id ?? msg.audio?.file_id
  if (!fileId) return null
  const config = readChannelsConfig()
  const stt = normalizeSttConfig(config.stt)
  if (!stt.autoTranscribe) return null
  if (stt.managed && stt.autoDeploy) {
    const deploy = await deployManagedSttContainer(stt)
    if (!deploy.ok) throw new Error(deploy.message)
  }
  const localPath = await downloadTelegramFile(token, fileId, rootDir, `telegram-audio-${msg.chat.id}-${fileId.slice(0, 8)}`)
  return await transcribeManagedAudioFile(localPath, stt)
}

function shouldShortCircuitAudioFailure(msg: TelegramMessage | undefined, transcript: { text: string; language?: string } | null) {
  if (!msg) return false
  const hasAudioLikeAttachment = Boolean(msg.audio || msg.voice)
  const hasUserText = Boolean(msg.text?.trim() || msg.caption?.trim())
  return hasAudioLikeAttachment && !hasUserText && !transcript?.text
}

function buildTelegramInboundText(msg: TelegramMessage | undefined, transcript?: { text: string; language?: string } | null) {
  if (!msg) return null
  const text = msg.text?.trim() || msg.caption?.trim() || ""
  const hasAudioLikeAttachment = Boolean(msg.audio || msg.voice)
  const hideAudioAttachmentFromModel = Boolean(transcript?.text)
  const slashCommand = normalizeTelegramCommand(text)
  if (slashCommand && !msg.photo && !msg.document && !msg.audio && !msg.video && !msg.voice && !msg.video_note) {
    return slashCommand
  }

  const parts: string[] = [`<channel source="telegram" chat_id="${msg.chat.id}">`]
  if (text) {
    parts.push(`<text>${escapeXml(text)}</text>`)
  }
  if (transcript?.text) {
    parts.push(`<transcript source="stt" language="${escapeXml(transcript.language ?? "")}">${escapeXml(transcript.text)}</transcript>`)
  } else if (hasAudioLikeAttachment) {
    parts.push(`<transcript source="stt" status="unavailable" />`)
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
  if (msg.audio && !hideAudioAttachmentFromModel) {
    parts.push(
      `<attachment kind="audio" file_id="${msg.audio.file_id}" title="${escapeXml(msg.audio.title ?? "")}" performer="${escapeXml(msg.audio.performer ?? "")}" mime_type="${escapeXml(msg.audio.mime_type ?? "")}" />`,
    )
  }
  if (msg.video) {
    parts.push(
      `<attachment kind="video" file_id="${msg.video.file_id}" mime_type="${escapeXml(msg.video.mime_type ?? "")}" width="${msg.video.width}" height="${msg.video.height}" />`,
    )
  }
  if (msg.voice && !hideAudioAttachmentFromModel) {
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
      `${buildWebSearchMenuText()}\n\nMode changed to: ${provider}${provider === "searxng" ? "\n\nStarting SearxNG..." : ""}`,
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
      `${buildWebSearchMenuText()}\n\nSend your next message with the query to test in SearxNG.`,
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
      `${buildChannelsMenuText()}\n\nTelegram ${config.telegram.enabled ? "enabled" : "disabled"}.`,
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
      `${buildChannelsMenuText()}\n\nAllowed chat list cleared.`,
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
      `${buildChannelsMenuText()}\n\nSend your next message with the Telegram token.`,
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
      `${buildChannelsMenuText()}\n\nSend your next message with the chat IDs separated by commas.`,
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
    logger.info("Starting Telegram integration...")
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
              logger.warn(`Telegram callback blocked (unauthorized chat): ${chatId}`)
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
          logger.error(`Error handling Telegram callback in chat ${chatId}: ${message}`)
          }
          return
        }

        const msg = update.message || update.channel_post
        if (!msg) return
        if (msg.from?.is_bot) {
          logger.debug(`Ignoring message from this bot or another bot in Telegram chat ${msg.chat.id}`)
          return
        }
        
        const chatId = msg.chat.id
        
        // Authorization
        if (config.telegram?.allowedChats && config.telegram.allowedChats.length > 0) {
          if (!config.telegram.allowedChats.includes(chatId)) {
            logger.warn(`Telegram message blocked (unauthorized chat): ${chatId}`)
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
                await sendTelegramMenu(config.telegram.token, chatId, "Empty token. Try /channels again.", buildChannelsMenuButtons())
                return
              }
              const nextConfig = readChannelsConfig()
              const telegram = nextConfig.telegram ?? { token: "", enabled: false, allowedChats: [] }
              nextConfig.telegram = { ...telegram, token, enabled: true }
              writeChannelsConfig(nextConfig)
              await sendTelegramMenu(config.telegram.token, chatId, "Token saved.", buildChannelsMenuButtons())
              options?.onRestartRequested?.()
              return
            }
            if (pending.kind === "channels-chats") {
              const raw = (msg.text ?? msg.caption ?? "").trim()
              const { ids, invalid } = parseAllowedChats(raw)
              if (invalid.length > 0) {
                await sendTelegramMenu(config.telegram.token, chatId, `Invalid IDs: ${invalid.join(", ")}`, buildChannelsMenuButtons())
                return
              }
              const nextConfig = readChannelsConfig()
              const telegram = nextConfig.telegram ?? { token: "", enabled: false, allowedChats: [] }
              nextConfig.telegram = { ...telegram, allowedChats: ids }
              writeChannelsConfig(nextConfig)
              await sendTelegramMenu(config.telegram.token, chatId, `Allowed chats saved: ${ids.join(", ")}`, buildChannelsMenuButtons())
              options?.onRestartRequested?.()
              return
            }
            if (pending.kind === "websearch-test") {
              const query = (msg.text ?? msg.caption ?? "").trim()
              if (!query) {
                await sendTelegramMenu(config.telegram.token, chatId, "Empty query. Try /websearch again.", buildWebSearchMenuButtons())
                return
              }
              const sessionId = `telegram-${chatId}`
              runtime.ensureSession(sessionId, `Telegram ${chatId}`)
              await runtime.processMessage(sessionId, `/websearch searxng test ${query}`)
              return
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error(`Error handling pending Telegram input in chat ${chatId}: ${message}`)
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

        let transcript: { text: string; language?: string } | null = null
        try {
          const result = await maybeTranscribeTelegramAudio(config.telegram.token, runtime.rootDir, msg)
          if (result) {
            transcript = result.ok
              ? { text: result.text, language: result.language }
              : null
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn(`STT failed for Telegram chat ${chatId}: ${message}`)
        }

        if (shouldShortCircuitAudioFailure(msg, transcript)) {
          await sendTelegramText(
            config.telegram.token,
            chatId,
            "I could not transcribe that audio automatically right now. Send it again later or send the text.",
          ).catch(() => {})
          return
        }

        const inboundText = buildTelegramInboundText(msg, transcript)
        if (!inboundText) return
        
        logger.debug(`Received Telegram message [${chatId}]`)

        // Ensure the session exists before sending the message
        try {
          runtime.ensureSession(sessionId, `Telegram ${chatId}`)
          await runtime.processMessage(sessionId, inboundText)
        } catch (error) {
          const err = error as Error & { code?: string }
          const detail = err.code ? ` code=${err.code}` : ""
          logger.error(`Error handling Telegram message in session ${sessionId}${detail}: ${err.message}`)
          if (err.stack) logger.debug(`Stack: ${err.stack}`)
        }
      },
      onError: (error) => {
        logger.error("Telegram poller error", error)
      }
    })
    
    activePoller.start()
  }
}

export function stopChannels() {
  if (activePoller) {
    logger.info("Stopping Telegram integration...")
    activePoller.stop()
    activePoller = null
  }
}
