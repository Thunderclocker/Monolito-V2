import { join } from "node:path"
import { getPaths } from "../ipc/protocol.ts"
import type { BootWingName } from "../bootstrap/bootWings.ts"
import { BOOT_WING_ORDER } from "../bootstrap/bootWings.ts"

/** Boot context files under memory/boot/*.md (BOOT_MEMORY lives at memory/memory.md). */
export const BOOT_WING_FILENAME: Record<Exclude<BootWingName, "BOOT_MEMORY">, string> = {
  BOOT_AGENTS: "agents.md",
  BOOT_SOUL: "soul.md",
  BOOT_TOOLS: "tools.md",
  BOOT_IDENTITY: "identity.md",
  BOOT_USER: "user.md",
  BOOT_BOOTSTRAP: "bootstrap.md",
}

export function memoryRoot(rootDir: string): string {
  return getPaths(rootDir).stateDir
}

export function bootDir(rootDir: string): string {
  return join(memoryRoot(rootDir), "boot")
}

export function memoryMdPath(rootDir: string): string {
  return join(memoryRoot(rootDir), "memory.md")
}

export function archiveDir(rootDir: string): string {
  return join(memoryRoot(rootDir), "archive")
}

export function bootWingFilePath(rootDir: string, wing: string): string | null {
  if (wing === "BOOT_MEMORY") return memoryMdPath(rootDir)
  const filename = BOOT_WING_FILENAME[wing as Exclude<BootWingName, "BOOT_MEMORY">]
  if (!filename) return null
  return join(bootDir(rootDir), filename)
}

export function wingFromBootFilename(filename: string): string | null {
  for (const wing of BOOT_WING_ORDER) {
    if (wing === "BOOT_MEMORY") continue
    if (BOOT_WING_FILENAME[wing] === filename) return wing
  }
  return null
}
