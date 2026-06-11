import { appendActionLog, readConfigWing, writeConfigWing } from "../session/store.ts"
import { MONOLITO_ROOT } from "../system/root.ts"

export type TelegramConfig = {
  token: string
  enabled: boolean
  allowedChats: number[]
}

export type TtsConfig = {
  baseUrl: string
  apiKey: string
  voice: string
  model: string
  responseFormat: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm"
  speed: number
  // Provider selector. When "minimax" the tool calls /v1/t2a_v2 with the
  // MiniMax-specific request/response shape (hex-encoded audio). When
  // "openai" it calls the OpenAI-compatible /v1/audio/speech endpoint
  // (works with api.openai.com and other hosted OpenAI-compatible APIs;
  // the previous "managed local Docker container" TTS was removed).
  provider?: "openai" | "minimax"
  // MiniMax-specific: alias -> voice_id map for cloned voices.
  clonedVoices?: Record<string, string>
  defaultClonedVoice?: string
  t2aModel?: string
}

export type SttConfig = {
  managed: boolean
  autoDeploy: boolean
  autoTranscribe: boolean
  port: number
  image: string
  containerName: string
  engine: "faster_whisper" | "openai_whisper" | "whisperx"
  model: string
  language: string
  vadFilter: boolean
}

export type HotkeyConfig = {
  /** Enable the global push-to-talk listener (requires X11 / `xinput`). */
  enabled: boolean
  /** X11 raw keycode(s) to watch. Can be a single number or an array of numbers. Defaults to 49 (º / ordmasculine on ES-layout). */
  keycode: number | number[]
}

export type ChannelsConfig = {
  telegram?: TelegramConfig
  tts?: Partial<TtsConfig>
  stt?: Partial<SttConfig>
  hotkey?: Partial<HotkeyConfig>
}

type LooseTelegramConfig = {
  token?: unknown
  bot_token?: unknown
  enabled?: unknown
  allowedChats?: unknown
  allowed_chats?: unknown
  authorized_chats?: unknown
  authorized_chat_ids?: unknown
}

type LooseChannelsConfig = ChannelsConfig & {
  telegram?: LooseTelegramConfig
}

const CHANNELS_TOP_LEVEL_KEYS = new Set(["telegram", "tts", "stt", "hotkey"])
const TELEGRAM_KEYS = new Set(["token", "enabled", "allowedChats"])
const TTS_KEYS = new Set(["baseUrl", "apiKey", "voice", "model", "responseFormat", "speed", "provider", "clonedVoices", "defaultClonedVoice", "t2aModel"])
const STT_KEYS = new Set(["managed", "autoDeploy", "autoTranscribe", "port", "image", "containerName", "engine", "model", "language", "vadFilter"])
const HOTKEY_KEYS = new Set(["enabled", "keycode"])

function hasOwn(object: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function assertValidChannelsConfigForWrite(config: unknown) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("CONF_CHANNELS must be an object.")
  }

  const record = config as Record<string, unknown>
  const unknownTopLevelKeys = Object.keys(record).filter(key => !CHANNELS_TOP_LEVEL_KEYS.has(key))
  if (unknownTopLevelKeys.length > 0) {
    throw new Error(`CONF_CHANNELS contains unsupported top-level keys: ${unknownTopLevelKeys.join(", ")}`)
  }
  if (hasOwn(record, "enabled")) {
    throw new Error("CONF_CHANNELS must not use root 'enabled'. Use 'telegram.enabled' instead.")
  }

  if (record.telegram !== undefined) {
    if (!record.telegram || typeof record.telegram !== "object" || Array.isArray(record.telegram)) {
      throw new Error("CONF_CHANNELS.telegram must be an object.")
    }
    const telegram = record.telegram as Record<string, unknown>
    if (hasOwn(telegram, "session_name")) {
      throw new Error("CONF_CHANNELS.telegram must not use 'session_name'. It is not part of the config schema.")
    }
    if (typeof telegram.token === "string" && typeof telegram.bot_token === "string" && telegram.token !== telegram.bot_token) {
      throw new Error("CONF_CHANNELS.telegram has conflicting 'token' and 'bot_token' values.")
    }
    const chatValues = [telegram.allowedChats, telegram.allowed_chats, telegram.authorized_chats, telegram.authorized_chat_ids]
      .filter(value => value !== undefined)
      .map(value => JSON.stringify(toIntegerArray(value)))
    if (new Set(chatValues).size > 1) {
      throw new Error("CONF_CHANNELS.telegram has conflicting allowed chat aliases. Use 'allowedChats'.")
    }
    const aliasKeys = new Set(["bot_token", "allowed_chats", "authorized_chats", "authorized_chat_ids"])
    const unknownTelegramKeys = Object.keys(telegram).filter(key => !TELEGRAM_KEYS.has(key) && !aliasKeys.has(key))
    if (unknownTelegramKeys.length > 0) {
      throw new Error(`CONF_CHANNELS.telegram contains unsupported keys: ${unknownTelegramKeys.join(", ")}`)
    }
  }

  if (record.tts !== undefined) {
    if (!record.tts || typeof record.tts !== "object" || Array.isArray(record.tts)) {
      throw new Error("CONF_CHANNELS.tts must be an object.")
    }
    const tts = record.tts as Record<string, unknown>
    const unknownTtsKeys = Object.keys(tts).filter(key => !TTS_KEYS.has(key))
    if (unknownTtsKeys.length > 0) {
      throw new Error(`CONF_CHANNELS.tts contains unsupported keys: ${unknownTtsKeys.join(", ")}`)
    }
  }

  if (record.stt !== undefined) {
    if (!record.stt || typeof record.stt !== "object" || Array.isArray(record.stt)) {
      throw new Error("CONF_CHANNELS.stt must be an object.")
    }
    const stt = record.stt as Record<string, unknown>
    const unknownSttKeys = Object.keys(stt).filter(key => !STT_KEYS.has(key))
    if (unknownSttKeys.length > 0) {
      throw new Error(`CONF_CHANNELS.stt contains unsupported keys: ${unknownSttKeys.join(", ")}`)
    }
  }

  if (record.hotkey !== undefined) {
    if (!record.hotkey || typeof record.hotkey !== "object" || Array.isArray(record.hotkey)) {
      throw new Error("CONF_CHANNELS.hotkey must be an object.")
    }
    const hotkey = record.hotkey as Record<string, unknown>
    const unknownHotkeyKeys = Object.keys(hotkey).filter(key => !HOTKEY_KEYS.has(key))
    if (unknownHotkeyKeys.length > 0) {
      throw new Error(`CONF_CHANNELS.hotkey contains unsupported keys: ${unknownHotkeyKeys.join(", ")}`)
    }
  }
}

function toIntegerArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map(item => typeof item === "number" ? item : Number(item))
    .filter(item => Number.isFinite(item) && item !== 0)
}

function normalizeTelegramConfig(value: unknown): TelegramConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const telegram = value as LooseTelegramConfig
  const tokenCandidate = telegram.token ?? telegram.bot_token
  const chatsCandidate = telegram.allowedChats ?? telegram.allowed_chats ?? telegram.authorized_chats ?? telegram.authorized_chat_ids
  const token = typeof tokenCandidate === "string" ? tokenCandidate : ""
  const allowedChats = toIntegerArray(chatsCandidate)
  const enabled = typeof telegram.enabled === "boolean"
    ? telegram.enabled
    : token.trim().length > 0
  return {
    token,
    enabled,
    allowedChats,
  }
}

export function normalizeChannelsConfig(config: unknown): ChannelsConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {}
  const loose = config as LooseChannelsConfig & { hotkey?: unknown }
  const normalized: ChannelsConfig = {}
  const telegram = normalizeTelegramConfig(loose.telegram)
  if (telegram) normalized.telegram = telegram
  if (loose.tts && typeof loose.tts === "object" && !Array.isArray(loose.tts)) {
    normalized.tts = { ...loose.tts }
  }
  if (loose.stt && typeof loose.stt === "object" && !Array.isArray(loose.stt)) {
    normalized.stt = { ...loose.stt }
  }
  if (loose.hotkey && typeof loose.hotkey === "object" && !Array.isArray(loose.hotkey)) {
    normalized.hotkey = { ...(loose.hotkey as Partial<HotkeyConfig>) }
  }
  return normalized
}

export function normalizeChannelsConfigForWrite(config: unknown): ChannelsConfig {
  assertValidChannelsConfigForWrite(config)
  return normalizeChannelsConfig(config)
}

export function readChannelsConfig(): ChannelsConfig {
  return normalizeChannelsConfig(readConfigWing(MONOLITO_ROOT, "CONF_CHANNELS"))
}

export function writeChannelsConfig(config: ChannelsConfig) {
  const normalized = normalizeChannelsConfig(config)
  writeConfigWing(MONOLITO_ROOT, "CONF_CHANNELS", normalized)
  appendActionLog(MONOLITO_ROOT, "Configuracion de canales actualizada", {
    wing: "CONF_CHANNELS",
    telegramEnabled: normalized.telegram?.enabled ?? false,
  })
}

const TTS_RESPONSE_FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"])

/**
 * Normalize a partial TTS config to a fully-typed TtsConfig. The fields
 * `managed`, `autoDeploy`, `port`, `image`, `containerName` were used by
 * the now-removed managed local TTS container; they are tolerated on
 * read (ignored silently) for backward compatibility with deployments
 * that still have them persisted in CONF_CHANNELS, but the type no
 * longer carries them so new writes can't set them.
 */
export function normalizeTtsConfig(config?: Partial<TtsConfig>): TtsConfig {
  return {
    baseUrl: typeof config?.baseUrl === "string" ? config.baseUrl.trim() : "",
    apiKey: typeof config?.apiKey === "string" ? config.apiKey.trim() : "",
    voice: typeof config?.voice === "string" && config.voice.trim() ? config.voice.trim() : (config?.provider === "openai" ? "alloy" : "female-shaonv"),
    model: typeof config?.model === "string" && config.model.trim() ? config.model.trim() : "tts-1",
    responseFormat:
      typeof config?.responseFormat === "string" && TTS_RESPONSE_FORMATS.has(config.responseFormat)
        ? config.responseFormat
        : "mp3",
    speed:
      typeof config?.speed === "number" && Number.isFinite(config.speed) && config.speed > 0
        ? config.speed
        : 1,
    provider: config?.provider === "openai" ? "openai" : "minimax",
    clonedVoices: config?.clonedVoices && typeof config.clonedVoices === "object" && !Array.isArray(config.clonedVoices)
      ? Object.fromEntries(
          Object.entries(config.clonedVoices).filter(([k, v]) => typeof k === "string" && typeof v === "string"),
        )
      : {},
    defaultClonedVoice: typeof config?.defaultClonedVoice === "string" ? config.defaultClonedVoice.trim() : "",
    t2aModel: typeof config?.t2aModel === "string" && config.t2aModel.trim() ? config.t2aModel.trim() : "speech-2.8-hd",
  }
}
