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

export type VisionConfig = {
  managed: boolean
  autoDeploy: boolean
  port: number
  containerName: string
  model: string
}

export type ChannelsConfig = {
  telegram?: TelegramConfig
  tts?: Partial<TtsConfig>
  stt?: Partial<SttConfig>
  vision?: Partial<VisionConfig>
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

const CHANNELS_TOP_LEVEL_KEYS = new Set(["telegram", "tts", "stt", "vision"])
const TELEGRAM_KEYS = new Set(["token", "enabled", "allowedChats"])
const VISION_KEYS = new Set(["managed", "autoDeploy", "port", "containerName", "model"])

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

  if (record.vision !== undefined) {
    if (!record.vision || typeof record.vision !== "object" || Array.isArray(record.vision)) {
      throw new Error("CONF_CHANNELS.vision must be an object.")
    }
    const vision = record.vision as Record<string, unknown>
    const unknownVisionKeys = Object.keys(vision).filter(key => !VISION_KEYS.has(key))
    if (unknownVisionKeys.length > 0) {
      throw new Error(`CONF_CHANNELS.vision contains unsupported keys: ${unknownVisionKeys.join(", ")}`)
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

function normalizeVisionConfig(value: unknown): VisionConfig | undefined {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) return undefined
  const vision = (value ?? {}) as Partial<VisionConfig>
  const port = typeof vision.port === "number" && Number.isFinite(vision.port) && vision.port > 0 && vision.port <= 65535
    ? Math.trunc(vision.port)
    : 11435
  return {
    managed: typeof vision.managed === "boolean" ? vision.managed : false,
    autoDeploy: typeof vision.autoDeploy === "boolean" ? vision.autoDeploy : true,
    port,
    containerName: typeof vision.containerName === "string" && vision.containerName.trim()
      ? vision.containerName.trim()
      : "monolito-vision-moondream",
    model: typeof vision.model === "string" && vision.model.trim() ? vision.model.trim() : "moondream",
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
  normalized.vision = normalizeVisionConfig(loose.vision)
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
