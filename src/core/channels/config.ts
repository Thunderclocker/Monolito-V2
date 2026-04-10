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
  bot_token?: unknown
  authorized_chat_ids?: unknown
}

type LooseChannelsConfig = ChannelsConfig & {
  telegram?: LooseTelegramConfig
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
  const token = typeof telegram.token === "string"
    ? telegram.token
    : typeof telegram.bot_token === "string"
      ? telegram.bot_token
      : ""
  const allowedChats = telegram.allowedChats !== undefined
    ? toIntegerArray(telegram.allowedChats)
    : toIntegerArray(telegram.authorized_chat_ids)
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
