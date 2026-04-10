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

export function readChannelsConfig(): ChannelsConfig {
  return readConfigWing(process.cwd(), "CONF_CHANNELS")
}

export function writeChannelsConfig(config: ChannelsConfig) {
  writeConfigWing(process.cwd(), "CONF_CHANNELS", config)
  appendActionLog(process.cwd(), "Configuracion de canales actualizada", {
    wing: "CONF_CHANNELS",
    telegramEnabled: config.telegram?.enabled ?? false,
  })
}
