import { isToolConcurrencySafe } from "../tools/registry.ts"
import type { ToolCall } from "./providers/types.ts"

export type IndexedToolCall = {
  toolCall: ToolCall
  index: number
}

const NEVER_PARALLEL = new Set([
  "Bash",
  "Shell",
  "Todo",
  "Telegram",
  "TelegramGet",
])

const PATH_SCOPED_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
])

const PATH_SCOPED_WRITES = new Set(["Write", "Edit", "MultiEdit"])

function normalizeScopePath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/")
  if (!trimmed || trimmed === ".") return "."
  const withoutTrailing = trimmed.replace(/\/+$/, "") || "."
  return withoutTrailing.startsWith("/") ? withoutTrailing : withoutTrailing
}

export function extractToolScopePaths(toolName: string, input: Record<string, unknown>): string[] {
  if (!PATH_SCOPED_TOOLS.has(toolName)) return []
  const rawPath = typeof input.path === "string" ? input.path : "."
  return [normalizeScopePath(rawPath || ".")]
}

export function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeScopePath(left)
  const b = normalizeScopePath(right)
  if (a === b) return true
  if (a === "." || b === ".") return true
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

export function canRunToolInParallelWave(
  toolName: string,
  input: Record<string, unknown>,
  reservedPaths: string[],
): boolean {
  if (NEVER_PARALLEL.has(toolName)) return false
  if (isToolConcurrencySafe(toolName, input)) {
    const paths = extractToolScopePaths(toolName, input)
    if (paths.length === 0) return true
    return !paths.some(path => reservedPaths.some(existing => pathsOverlap(path, existing)))
  }
  if (!PATH_SCOPED_WRITES.has(toolName)) return false
  const paths = extractToolScopePaths(toolName, input)
  if (paths.length === 0) return false
  return !paths.some(path => reservedPaths.some(existing => pathsOverlap(path, existing)))
}

export function planToolExecutionWaves(indexedToolCalls: IndexedToolCall[]): IndexedToolCall[][] {
  const waves: IndexedToolCall[][] = []
  let currentWave: IndexedToolCall[] = []
  let reservedPaths: string[] = []

  const flush = () => {
    if (currentWave.length > 0) waves.push(currentWave)
    currentWave = []
    reservedPaths = []
  }

  for (const item of indexedToolCalls) {
    const { toolCall } = item
    if (currentWave.length === 0) {
      currentWave.push(item)
      reservedPaths.push(...extractToolScopePaths(toolCall.name, toolCall.input))
      continue
    }

    if (canRunToolInParallelWave(toolCall.name, toolCall.input, reservedPaths)) {
      currentWave.push(item)
      reservedPaths.push(...extractToolScopePaths(toolCall.name, toolCall.input))
      continue
    }

    flush()
    currentWave.push(item)
    reservedPaths.push(...extractToolScopePaths(toolCall.name, toolCall.input))
  }

  flush()
  return waves
}
