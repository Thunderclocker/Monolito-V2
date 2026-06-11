import { createLogger } from "../logging/logger.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readChannelsConfig, writeChannelsConfig } from "./config.ts"
import { readWebSearchConfig, writeWebSearchConfig } from "../websearch/config.ts"
import { createTelegramPoller, isTerminalTelegramTokenError, type TelegramCallbackQuery, type TelegramMessage, type TelegramPoller } from "./telegramPoller.ts"
import type { MonolitoV2Runtime } from "../runtime/runtime.ts"
import { ensureDirs, MAIN_SESSION_ID } from "../ipc/protocol.ts"
import { deployManagedSttContainer, getManagedSttStatus, normalizeSttConfig, probeManagedStt, transcribeManagedAudioFile } from "../stt/managed.ts"
import { appendWorklog, markTelegramUpdateProcessed, persistTelegramUpdate } from "../session/store.ts"

const logger = createLogger("channels")
let activePoller: TelegramPoller | null = null
let activeDeliveryUnregister: (() => void) | null = null
const pendingTelegramInputs = new Map<number, { kind: "channels-token" | "channels-chats" | "websearch-test" }>()

/**
 * Map of pending permission requests that were forwarded to a Telegram
 * chat as inline buttons. Keyed by chatId so that when a button is
 * clicked we can find the pending permission and resolve it. Cleaned
 * up on resolution.
 *
 * The 60s safety net in registry.ts (commit 1bc5a9c) is the fallback
 * for when the user does NOT respond in Telegram within 60s. This map
 * is the FAST path — the user can click Allow/Deny in Telegram and the
 * agent unblocks within seconds instead of 60s.
 */
const pendingTelegramPermissions = new Map<number, { sessionId: string; permissionId: string; tool: string; path: string; reason: string }>()


const TELEGRAM_BOT_COMMANDS = [
  { command: "help", description: "Show available commands" },
  { command: "model", description: "Show current model configuration" },
  { command: "channels", description: "Configure Telegram channel settings" },
  { command: "update", description: "Fetch updates and restart daemon" },
  { command: "new", description: "Start a fresh session" },
  { command: "adult", description: "Toggle adult mode" },
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

function chunkTelegramText(text: string, maxLength = 4096) {
  const normalized = text.replace(/\r\n/g, "\n")
  if (normalized.length <= maxLength) return [normalized]
  const chunks: string[] = []
  let remaining = normalized
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength)
    const splitAt = Math.max(candidate.lastIndexOf("\n\n"), candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "))
    const boundary = splitAt > maxLength * 0.5 ? splitAt : maxLength
    chunks.push(remaining.slice(0, boundary).trim())
    remaining = remaining.slice(boundary).trimStart()
  }
  if (remaining.trim()) chunks.push(remaining.trim())
  return chunks.filter(Boolean)
}

async function sendTelegramText(token: string, chatId: number, text: string) {
  for (const chunk of chunkTelegramText(text)) {
    await telegramApi(token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
    })
  }
}

function dispatchRuntimeMessage(runtime: MonolitoV2Runtime, sessionId: string, title: string, text: string, detail: string, telegram?: { token: string; chatId: number }, onRestartRequested?: () => void) {
  runtime.ensureSession(sessionId, title)
  void (async () => {
    const delivery = telegram ? { channel: "telegram", targetId: String(telegram.chatId) } : undefined
    // Telegram's typing action expires after ~5s. We need to re-send it
    // during long generations so the user sees continuous "typing..." in
    // the chat. model_stream events fire on every token chunk, so we
    // debounce to one typing-action every 3s to respect Telegram's
    // ~1 chat action per second per chat rate limit.
    const TYPING_DEBOUNCE_MS = 3_000
    let lastTypingSentAt = 0
    const sendTyping = () => {
      if (!telegram) return
      const now = Date.now()
      if (now - lastTypingSentAt < TYPING_DEBOUNCE_MS) return
      lastTypingSentAt = now
      void telegramApi(telegram.token, "sendChatAction", {
        chat_id: telegram.chatId,
        action: "typing",
      }).catch(() => {})
    }
    for await (const event of runtime.processMessageEvents(sessionId, text, { delivery })) {
      if (!telegram) continue
      if (
        event.type === "tool_execute_start" ||
        event.type === "recoverable_error" ||
        event.type === "model_invoke_start" ||
        event.type === "model_stream" ||
        event.type === "model_thinking"
      ) {
        sendTyping()
      }
    }
    if (runtime.consumeRestartRequest()) {
      onRestartRequested?.()
    }
  })().catch(error => {
    const typed = error as Error & { code?: string }
    const code = typed.code ? ` code=${typed.code}` : ""
    logger.error(`Async Telegram dispatch failed (${detail})${code}: ${typed.message}`)
  })
}

function parseAllowedChats(raw: string) {
  const ids = raw.split(",").map(item => item.trim()).filter(Boolean).map(Number)
  const invalid = ids.filter(item => !Number.isFinite(item) || item === 0)
  return { ids, invalid }
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
    const isRunning = (await getManagedSttStatus(stt)) === "running" && (await probeManagedStt(stt))
    if (!isRunning) {
      await sendTelegramText(
        token,
        msg.chat.id,
        "Un momento, por favor. Estoy preparando el servicio de transcripción de voz local (esto puede tardar unos minutos si es la primera vez que se descarga el modelo Whisper)..."
      ).catch(() => {})
    }
    const deploy = await deployManagedSttContainer(stt)
    if (!deploy.ok) throw new Error(deploy.message)
    if (!isRunning) {
      await sendTelegramText(
        token,
        msg.chat.id,
        "¡Listo! El servicio de voz se ha iniciado correctamente. Procedo a transcribir y analizar tu audio..."
      ).catch(() => {})
    }
  }
  const localPath = await downloadTelegramFile(token, fileId, rootDir, `telegram-audio-${msg.chat.id}-${fileId.slice(0, 8)}`)
  return await transcribeManagedAudioFile(localPath, stt)
}

function getLargestTelegramPhoto(msg: TelegramMessage | undefined) {
  if (!msg?.photo?.length) return null
  return [...msg.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0] ?? null
}

function shouldShortCircuitAudioFailure(msg: TelegramMessage | undefined, transcript: { text: string; language?: string } | null) {
  if (!msg) return false
  const hasAudioLikeAttachment = Boolean(msg.audio || msg.voice)
  const hasUserText = Boolean(msg.text?.trim() || msg.caption?.trim())
  return hasAudioLikeAttachment && !hasUserText && !transcript?.text
}

function buildTelegramInboundText(
  msg: TelegramMessage | undefined,
  transcript?: { text: string; language?: string } | null,
  visionTranscript?: string | null,
  localPhotoPath?: string | null,
  localDocPath?: string | null,
) {
  if (!msg) return null
  const text = msg.text?.trim() || msg.caption?.trim() || ""
  const hasAudioLikeAttachment = Boolean(msg.audio || msg.voice)
  // NOTA: el attachment de audio/voice se emite siempre (con file_id) aunque haya
  // transcript, para que el modelo pueda invocar VoiceClone con source.type='telegram_file_id'.
  // Antes se ocultaba cuando habia transcript (`hideAudioAttachmentFromModel`), pero eso
  // rompia voice clone porque el modelo no veia el file_id del audio entrante.
  const hideAudioAttachmentFromModel = false
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
  if (visionTranscript?.trim()) {
    parts.push(`<transcript source="vision_fallback">Descripción visual: ${escapeXml(visionTranscript.trim())}</transcript>`)
  }

  if (msg.photo?.length && !visionTranscript?.trim()) {
    const largest = getLargestTelegramPhoto(msg)
    if (largest) {
      const localPathAttr = localPhotoPath ? ` local_path="${escapeXml(localPhotoPath)}"` : ""
      parts.push(`<attachment kind="photo" file_id="${largest.file_id}" width="${largest.width}" height="${largest.height}"${localPathAttr} />`)
    }
  }
  if (msg.document) {
    const localPathAttr = localDocPath ? ` local_path="${escapeXml(localDocPath)}"` : ""
    const limitExceededAttr = msg.document.file_size && msg.document.file_size > 20 * 1024 * 1024
      ? ` status="size_limit_exceeded" size_bytes="${msg.document.file_size}" max_limit_bytes="${20 * 1024 * 1024}"`
      : ""
    parts.push(
      `<attachment kind="document" file_id="${msg.document.file_id}" file_name="${escapeXml(msg.document.file_name ?? "")}" mime_type="${escapeXml(msg.document.mime_type ?? "")}"${localPathAttr}${limitExceededAttr} />`,
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
      `${buildChannelsMenuText()}\n\nTelegram ${telegram.enabled ? "enabled" : "disabled"}.`,
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

export function startChannels(runtime: MonolitoV2Runtime, options?: { onRestartRequested?: () => void; onStopRequested?: () => void }) {
  const config = readChannelsConfig()
  process.stderr.write(`[ChannelManager] startChannels called. Telegram enabled: ${!!config.telegram?.enabled}\n`)

  if (!config.telegram?.enabled || !config.telegram.token) {
    activeDeliveryUnregister?.()
    activeDeliveryUnregister = null
  }

  if (config.telegram?.enabled && config.telegram.token) {
    // Narrow the optional type so the rest of this block doesn't need `?.` everywhere.
    const telegram = config.telegram
    logger.info("Starting Telegram integration...")
    activeDeliveryUnregister?.()
    activeDeliveryUnregister = runtime.registerDeliveryChannel("telegram", async (targetId, text) => {
      const latestConfig = readChannelsConfig()
      const telegram = latestConfig.telegram
      if (!telegram?.enabled || !telegram.token) return
      const chatId = Number(targetId)
      if (!Number.isFinite(chatId) || chatId === 0) {
        throw new Error(`Invalid Telegram delivery target: ${targetId}`)
      }
      await sendTelegramText(telegram.token, chatId, text)
    })

    // Worker completion is routed back through the runtime coordinator. The
    // coordinator owns all user-facing Telegram replies so internal workers do
    // not speak directly to chats or leak orchestration details.

    void registerTelegramCommands(telegram.token)
      .then(() => {
        logger.info("Comandos de Telegram registrados")
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`No se pudieron registrar los comandos sugeridos de Telegram: ${message}`)
      })

    activePoller = createTelegramPoller(
      telegram.token,
      {
      onUpdate: async (update) => {
        if (update.callback_query) {
          const callback = update.callback_query
          const callbackMessage = callback.message
          const chatId = callbackMessage?.chat.id ?? callback.from.id
          if (config.telegram?.allowedChats && telegram.allowedChats.length > 0) {
            if (!telegram.allowedChats.includes(chatId)) {
              logger.warn(`Telegram callback blocked (unauthorized chat): ${chatId}`)
              return
            }
          }

          await answerTelegramCallback(telegram.token, callback.id)

          // Permission inline-button callback. Resolves the pending
          // permission and edits the original message to show the decision.
          const data = callback.data ?? ""
          if (data.startsWith("perm:")) {
            const parts = data.split(":")
            if (parts.length === 3 && (parts[2] === "allow" || parts[2] === "deny")) {
              const permissionId = parts[1]!
              const decision = parts[2] as "allow" | "deny"
              const resolved = runtime.resolvePendingPermission(permissionId, decision)
              // Find the chat and the original message to update.
              const chatId = callbackMessage?.chat.id ?? callback.from.id
              const pending = pendingTelegramPermissions.get(chatId)
              if (pending) pendingTelegramPermissions.delete(chatId)

              if (resolved) {
                appendWorklog(runtime.rootDir, pending?.sessionId ?? `telegram-${chatId}`, {
                  type: "note",
                  summary: `PERMISSION_VIA_TELEGRAM: user clicked '${decision}' on permissionId=${permissionId} (tool=${pending?.tool ?? "?"}, path=${pending?.path ?? "?"})`,
                })
                // Edit the original message to reflect the decision so
                // the user has visual confirmation.
                if (callbackMessage && pending) {
                  const label = decision === "allow" ? "✅ Allowed" : "❌ Denied"
                  const isDestructive = pending.reason.includes("contains destructive commands") || pending.tool === "Bash"
                  const confirmation = isDestructive
                    ? `⚠️ **Destructive Action ${label}**\n\nTool: \`${pending.tool}\`\nAction: \`${pending.path}\`\n\nThe agent will ${decision === "allow" ? "proceed" : "be denied execution"}.`
                    : `🔐 **Permission ${label}**\n\nTool: \`${pending.tool}\`\nPath: \`${pending.path}\`\n\nThe agent will ${decision === "allow" ? "proceed" : "be denied access"}.`
                  await editTelegramMenu(
                    telegram.token!,
                    chatId,
                    callbackMessage.message_id,
                    confirmation,
                    [],
                  ).catch(() => {})
                }
              } else {
                // The permission already resolved (probably via safety net). Tell the user.
                await sendTelegramText(
                  telegram.token!,
                  chatId,
                  "⚠️ Request already resolved or timed out (no action taken).",
                ).catch(() => {})
              }
              return
            }
          }

          try {
            const channelResult = await handleChannelsCallback(telegram.token, callback)
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
        if (config.telegram?.allowedChats && telegram.allowedChats.length > 0) {
          if (!telegram.allowedChats.includes(chatId)) {
            logger.warn(`Telegram message blocked (unauthorized chat): ${chatId}`)
            return
          }
        }
        
        const sessionId = MAIN_SESSION_ID

        const pending = pendingTelegramInputs.get(chatId)
        if (pending) {
          pendingTelegramInputs.delete(chatId)
          try {
            if (pending.kind === "channels-token") {
              const token = (msg.text ?? msg.caption ?? "").trim()
              if (!token) {
                await sendTelegramMenu(telegram.token, chatId, "Empty token. Try /channels again.", buildChannelsMenuButtons())
                return
              }
              const nextConfig = readChannelsConfig()
              const telegramCfg = nextConfig.telegram ?? { token: "", enabled: false, allowedChats: [] }
              nextConfig.telegram = { ...telegramCfg, token, enabled: true }
              writeChannelsConfig(nextConfig)
              await sendTelegramMenu(telegram.token, chatId, "Token saved.", buildChannelsMenuButtons())
              options?.onRestartRequested?.()
              return
            }
            if (pending.kind === "channels-chats") {
              const raw = (msg.text ?? msg.caption ?? "").trim()
              const { ids, invalid } = parseAllowedChats(raw)
              if (invalid.length > 0) {
                await sendTelegramMenu(telegram.token, chatId, `Invalid IDs: ${invalid.join(", ")}`, buildChannelsMenuButtons())
                return
              }
              const nextConfig = readChannelsConfig()
              const telegramCfg = nextConfig.telegram ?? { token: "", enabled: false, allowedChats: [] }
              nextConfig.telegram = { ...telegram, allowedChats: ids }
              writeChannelsConfig(nextConfig)
              await sendTelegramMenu(telegram.token, chatId, `Allowed chats saved: ${ids.join(", ")}`, buildChannelsMenuButtons())
              options?.onRestartRequested?.()
              return
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.error(`Error handling pending Telegram input in chat ${chatId}: ${message}`)
            return
          }
        }

        const normalized = normalizeTelegramCommand(msg.text?.trim() || msg.caption?.trim() || "")

        if (normalized === "/channels") {
          await sendTelegramMenu(telegram.token, chatId, buildChannelsMenuText(), buildChannelsMenuButtons())
          return
        }

        let transcript: { text: string; language?: string } | null = null
        try {
          const result = await maybeTranscribeTelegramAudio(telegram.token, runtime.rootDir, msg)
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
            telegram.token,
            chatId,
            "I could not transcribe that audio automatically right now. Send it again later or send the text.",
          ).catch(() => {})
          return
        }

        let localPhotoPath: string | null = null
        if (msg.photo?.length) {
          try {
            const largest = getLargestTelegramPhoto(msg)
            if (largest) {
              const prefix = `telegram-photo-${msg.chat.id}-${Date.now()}-${largest.file_id.slice(0, 8)}`
              localPhotoPath = await downloadTelegramFile(telegram.token, largest.file_id, runtime.rootDir, prefix)
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn(`Photo auto-download failed for Telegram chat ${chatId}: ${message}`)
          }
        }

        let localDocPath: string | null = null
        if (msg.document) {
          try {
            const maxSizeBytes = 20 * 1024 * 1024
            if (!msg.document.file_size || msg.document.file_size <= maxSizeBytes) {
              const safeName = msg.document.file_name ? msg.document.file_name.replace(/[^a-zA-Z0-9._-]/g, "_") : `doc-${msg.document.file_id.slice(0, 8)}`
              const prefix = `telegram-doc-${msg.chat.id}-${Date.now()}-${safeName}`
              localDocPath = await downloadTelegramFile(telegram.token, msg.document.file_id, runtime.rootDir, prefix)
            } else {
              logger.warn(`Telegram document skipped (size exceeds limit): ${msg.document.file_name} (${msg.document.file_size} bytes)`)
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn(`Document auto-download failed for Telegram chat ${chatId}: ${message}`)
          }
        }

        const inboundText = buildTelegramInboundText(msg, transcript, null, localPhotoPath, localDocPath)
        if (!inboundText) return
        
        logger.debug(`Received Telegram message [${chatId}]`)

        // Ensure the session exists before sending the message
        try {
          dispatchRuntimeMessage(runtime, sessionId, `Telegram ${chatId}`, inboundText, `message ${chatId}:${msg.message_id}`, {
            token: telegram.token,
            chatId,
          }, options?.onRestartRequested)
        } catch (error) {
          const err = error as Error & { code?: string }
          const detail = err.code ? ` code=${err.code}` : ""
          logger.error(`Error handling Telegram message in session ${sessionId}${detail}: ${err.message}`)
          if (err.stack) logger.debug(`Stack: ${err.stack}`)
        }
      },

      onError: (error) => {
        logger.error("Telegram poller error", error)
        if (isTerminalTelegramTokenError(error)) {
          logger.error("[Telegram] Token inválido (401/404) — canal deshabilitado. Usa /channels token <real-token> y reinicia el daemon.")
          stopChannels("telegram-terminal-error")
          return
        }
      }
    },
    {
      // Durability: persist every incoming update BEFORE onUpdate runs.
      // If the daemon crashes mid-process, the next startup sees the
      // unprocessed row in telegram_raw_updates and can replay it. The
      // Telegram long-poller also re-delivers on next start (offset is
      // re-fetched from getUpdates), so this is defense in depth.
      persistRawUpdate: (updateId, chatId, rawJson) => {
        persistTelegramUpdate(runtime.rootDir, updateId, chatId, rawJson)
      },
      markProcessed: (updateId) => {
        markTelegramUpdateProcessed(runtime.rootDir, updateId)
      },
    },
    )

    // Subscribe to runtime events to surface permission requests to
    // the Telegram user as inline buttons. Without this, permission
    // requests in Telegram sessions would either hang until the 60s
    // safety net (commit 1bc5a9c) or stay pending forever if no
    // safety net existed. The CLI path still uses the TUI prompt as
    // before — this only kicks in for sessions whose sessionId starts
    // with "telegram-".
    const unsubscribePermissions = runtime.onEvent((event) => {
      if (event.type !== "permission.request" && event.type !== "destructive.confirm") return
      const isDestructive = event.type === "destructive.confirm"
      // event is narrowed to permission.request or destructive.confirm
      // by the type check above. Both shapes include sessionId.
      // Resolve chatId from session ID prefix (telegram-<chatId>) or from
      // the session's active delivery context (e.g. main session used via Telegram).
      let chatId: number | null = null
      if (event.sessionId.startsWith("telegram-")) {
        const chatIdRaw = event.sessionId.slice("telegram-".length)
        chatId = Number(chatIdRaw)
      } else {
        const delivery = runtime.getDeliveryContext(event.sessionId)
        if (delivery && delivery.channel === "telegram") {
          chatId = Number(delivery.targetId)
        }
      }
      if (!chatId || !Number.isFinite(chatId) || chatId === 0) return

      const permissionId = isDestructive
        ? (event as { confirmId: string }).confirmId
        : (event as { permissionId: string }).permissionId
      const path = isDestructive
        ? (event as { command: string }).command
        : (event as { path: string }).path

      // Track the pending permission so the callback handler can resolve
      // it when the user clicks Allow/Deny.
      pendingTelegramPermissions.set(chatId, {
        sessionId: event.sessionId,
        permissionId,
        tool: event.tool,
        path,
        reason: event.reason,
      })

      const text = isDestructive
        ? `⚠️ **Destructive Action Detected**\n\nTool: \`${event.tool}\`\nAction: \`${path}\`\n\nReason: *${event.reason}*\n\nThe agent is waiting for your decision. It will auto-deny after 30s if you don't respond.`
        : `🔐 **Permission Request**\n\nTool: \`${event.tool}\`\nPath: \`${path}\`\n\n${event.reason}\n\nThe agent is waiting for your decision. It will auto-deny after 60s if you don't respond.`

      // Inline keyboard: Allow / Deny. Callback data encodes the
      // permissionId and decision so the callback handler can resolve.
      const buttons: TelegramInlineButton[][] = [
        [
          { text: "✅ Allow", callback_data: `perm:${permissionId}:allow` },
          { text: "❌ Deny", callback_data: `perm:${permissionId}:deny` },
        ],
      ]
      void sendTelegramMenu(telegram.token!, chatId, text, buttons).catch((err) => {
        logger.warn(`Failed to send Telegram permission prompt: ${err instanceof Error ? err.message : String(err)}`)
      })
    })
    // Store the unsubscribe so stopChannels can clean up.
    const previousUnregister = activeDeliveryUnregister
    activeDeliveryUnregister = () => {
      unsubscribePermissions()
      previousUnregister?.()
    }

    activePoller.start()
  }
}

export function stopChannels(reason?: string) {
  activeDeliveryUnregister?.()
  activeDeliveryUnregister = null
  if (activePoller) {
    if (reason === "telegram-terminal-error") {
      logger.info("Stopping Telegram integration (invalid token, no restart)")
    } else {
      logger.info("Stopping Telegram integration...")
    }
    activePoller.stop()
    activePoller = null
  }
}
