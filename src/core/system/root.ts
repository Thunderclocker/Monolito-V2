import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const MONOLITO_ROOT = join(homedir(), ".monolito-v2")

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
    const files = readdirSync(scratchpadDir)
    const now = Date.now()
    const maxAgeMs = 24 * 60 * 60 * 1000

    for (const file of files) {
      const filePath = join(scratchpadDir, file)
      try {
        const stats = statSync(filePath)
        if (now - stats.mtimeMs > maxAgeMs) {
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
