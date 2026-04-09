import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const CHANNELS_FILE = join(homedir(), ".monolito-v2", "channels.json")

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

export type ChannelsConfig = {
  telegram?: TelegramConfig
  tts?: Partial<TtsConfig>
}

export function readChannelsConfig(): ChannelsConfig {
  try {
    const raw = readFileSync(CHANNELS_FILE, "utf-8")
    return JSON.parse(raw) as ChannelsConfig
  } catch {
    return {}
  }
}

export function writeChannelsConfig(config: ChannelsConfig) {
  mkdirSync(join(homedir(), ".monolito-v2"), { recursive: true })
  writeFileSync(CHANNELS_FILE, JSON.stringify(config, null, 2))
}
