// Telegram audio/voice dedupe state. Pure filesystem helpers (JSON set) —
// isolated from the rest of the tool registry so unit tests can import
// them without dragging in the pre-existing file.ts / registry.ts
// circular-reference crash under --experimental-strip-types.
//
// Mirrors the photo pattern: the runtime keeps a JSON set of sent audio
// local paths, and TelegramSendVoice/Audio skip sending when the same
// path is already in the set. Prevents the model from regenerating the
// same audio after a guard re-feed and re-sending it (observed
// 2026-06-09: user received two distinct audio clips with message_ids
// 21213 and 21215 in the same turn).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const TELEGRAM_SENT_AUDIOS_KEY = "telegram_sent_audios"

function sentAudiosFile(rootDir: string): string {
  return join(rootDir, "run", `${TELEGRAM_SENT_AUDIOS_KEY}.json`)
}

export function getAlreadySentAudios(rootDir: string): Set<string> {
  try {
    const stateFile = sentAudiosFile(rootDir)
    if (existsSync(stateFile)) {
      const data = JSON.parse(readFileSync(stateFile, "utf8")) as string[]
      return new Set(data)
    }
  } catch {}
  return new Set()
}

export function markAudioAsSent(rootDir: string, audioPath: string) {
  try {
    const stateFile = sentAudiosFile(rootDir)
    const sent = getAlreadySentAudios(rootDir)
    sent.add(audioPath)
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, JSON.stringify([...sent]), "utf8")
  } catch {}
}

export function isAudioAlreadySent(rootDir: string, audioPath: string): boolean {
  return getAlreadySentAudios(rootDir).has(audioPath)
}
