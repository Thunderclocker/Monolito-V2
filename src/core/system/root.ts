import { mkdirSync } from "node:fs"
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
