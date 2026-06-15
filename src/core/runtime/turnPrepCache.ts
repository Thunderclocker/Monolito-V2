import { statSync } from "node:fs"
import { join } from "node:path"
import { createMarkdownMemoryStore } from "../storage/markdownMemory.ts"

type BootCacheEntry = {
  mtimes: Record<string, number>
  memoryMdMtime: number
  block: string
}

const bootCache = new Map<string, BootCacheEntry>()

const BOOT_WINGS = ["BOOT_AGENTS", "BOOT_SOUL", "BOOT_TOOLS", "BOOT_IDENTITY", "BOOT_USER", "BOOT_BOOTSTRAP"]

function readMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function bootFingerprint(rootDir: string): Record<string, number> {
  const mtimes: Record<string, number> = {}
  for (const wing of BOOT_WINGS) {
    mtimes[wing] = readMtime(join(rootDir, "memory", "boot", `${wing}.md`))
  }
  return mtimes
}

export function getCachedBootBlock(rootDir: string): string {
  const memoryMdMtime = readMtime(join(rootDir, "memory", "memory.md"))
  const mtimes = bootFingerprint(rootDir)
  const cached = bootCache.get(rootDir)
  if (cached && cached.memoryMdMtime === memoryMdMtime && JSON.stringify(cached.mtimes) === JSON.stringify(mtimes)) {
    return cached.block
  }
  const store = createMarkdownMemoryStore(rootDir)
  const block = store.buildCachedContextBlock()
  bootCache.set(rootDir, { mtimes, memoryMdMtime, block })
  return block
}

export function invalidateBootCache(rootDir?: string) {
  if (rootDir) {
    bootCache.delete(rootDir)
    return
  }
  bootCache.clear()
}

export function scheduleBootBlockPrefetch(rootDir: string) {
  setImmediate(() => {
    try {
      getCachedBootBlock(rootDir)
    } catch {
      // Best-effort warmup.
    }
  })
}
