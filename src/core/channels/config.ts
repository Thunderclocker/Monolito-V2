import { appendActionLog, readConfigWing, writeConfigWing } from "../session/store.ts"

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
  managed: boolean
  autoDeploy: boolean
  port: number
  image: string
  containerName: string
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

export type ChannelsConfig = {
  telegram?: TelegramConfig
  tts?: Partial<TtsConfig>
  stt?: Partial<SttConfig>
}

type LooseTelegramConfig = {
  token?: unknown
  enabled?: unknown
  allowedChats?: unknown
}

type LooseChannelsConfig = ChannelsConfig & {
  telegram?: LooseTelegramConfig
}

const CHANNELS_TOP_LEVEL_KEYS = new Set(["telegram", "tts", "stt"])
const TELEGRAM_KEYS = new Set(["token", "enabled", "allowedChats"])

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
    if (hasOwn(telegram, "bot_token")) {
      throw new Error("CONF_CHANNELS.telegram must not use 'bot_token'. Use 'token' instead.")
    }
    if (hasOwn(telegram, "authorized_chat_ids")) {
      throw new Error("CONF_CHANNELS.telegram must not use 'authorized_chat_ids'. Use 'allowedChats' instead.")
    }
    if (hasOwn(telegram, "session_name")) {
      throw new Error("CONF_CHANNELS.telegram must not use 'session_name'. It is not part of the config schema.")
    }
    const unknownTelegramKeys = Object.keys(telegram).filter(key => !TELEGRAM_KEYS.has(key))
    if (unknownTelegramKeys.length > 0) {
      throw new Error(`CONF_CHANNELS.telegram contains unsupported keys: ${unknownTelegramKeys.join(", ")}`)
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
  const token = typeof telegram.token === "string" ? telegram.token : ""
  const allowedChats = toIntegerArray(telegram.allowedChats)
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
  const loose = config as LooseChannelsConfig
  const normalized: ChannelsConfig = {}
  const telegram = normalizeTelegramConfig(loose.telegram)
  if (telegram) normalized.telegram = telegram
  if (loose.tts && typeof loose.tts === "object" && !Array.isArray(loose.tts)) {
    normalized.tts = { ...loose.tts }
  }
  if (loose.stt && typeof loose.stt === "object" && !Array.isArray(loose.stt)) {
    normalized.stt = { ...loose.stt }
  }
  return normalized
}

export function normalizeChannelsConfigForWrite(config: unknown): ChannelsConfig {
  assertValidChannelsConfigForWrite(config)
  return normalizeChannelsConfig(config)
}

export function readChannelsConfig(): ChannelsConfig {
  return normalizeChannelsConfig(readConfigWing(process.cwd(), "CONF_CHANNELS"))
}

export function writeChannelsConfig(config: ChannelsConfig) {
  const normalized = normalizeChannelsConfig(config)
  writeConfigWing(process.cwd(), "CONF_CHANNELS", normalized)
  appendActionLog(process.cwd(), "Configuracion de canales actualizada", {
    wing: "CONF_CHANNELS",
    telegramEnabled: normalized.telegram?.enabled ?? false,
  })
}
