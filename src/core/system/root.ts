import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function loadEnvFile(envPath: string) {
  if (!existsSync(envPath)) return
  try {
    const content = readFileSync(envPath, "utf8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const index = trimmed.indexOf("=")
      if (index === -1) continue
      const key = trimmed.slice(0, index).trim()
      let val = trimmed.slice(index + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (key) {
        process.env[key] = val
      }
    }
  } catch {}
}

const defaultRoot = join(homedir(), ".monolito")

export const MONOLITO_ROOT = process.env.MONOLITO_ROOT || defaultRoot

// Cargar variables del .env global
loadEnvFile(join(MONOLITO_ROOT, ".env"))

export function ensureMonolitoRoot() {
  mkdirSync(MONOLITO_ROOT, { recursive: true })
  mkdirSync(join(MONOLITO_ROOT, "memory"), { recursive: true })
  mkdirSync(join(MONOLITO_ROOT, "logs"), { recursive: true })
  mkdirSync(join(MONOLITO_ROOT, "logs", "instances"), { recursive: true })
  mkdirSync(join(MONOLITO_ROOT, "run"), { recursive: true })
  mkdirSync(join(MONOLITO_ROOT, "profiles"), { recursive: true })
  mkdirSync(join(MONOLITO_ROOT, "scratchpad"), { recursive: true })
  return MONOLITO_ROOT
}

export function cleanupScratchpad() {
  const scratchpadDir = join(MONOLITO_ROOT, "scratchpad")
  try {
    const files = readdirSync(scratchpadDir, { recursive: true }) as string[]
    const now = Date.now()
    const maxAgeMs = 24 * 60 * 60 * 1000

    for (const file of files) {
      const filePath = join(scratchpadDir, file)
      try {
        const stats = statSync(filePath)
        if (stats.isFile() && (now - stats.mtimeMs > maxAgeMs)) {
          unlinkSync(filePath)
        }
      } catch {
        // Ignore individual file cleanup failures.
      }
    }
  } catch {
    // Ignore missing scratchpad directory or listing failures.
  }
}
