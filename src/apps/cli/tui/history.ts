import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { getPaths } from "../../../core/ipc/protocol.ts"
import type { PromptHistory } from "./types.ts"

export const CLI_HISTORY_LIMIT = 200

const SECRET_PATTERNS = [
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{8,}/i,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\b\s*[:=]\s*["']?[^\s"'`]{6,}/i,
]

export function isSensitiveHistoryEntry(line: string) {
  return SECRET_PATTERNS.some(pattern => pattern.test(line))
}

export function getHistoryFilePath(rootDir: string) {
  return `${getPaths(rootDir).stateDir}/cli-history.json`
}

export function readPromptHistory(rootDir: string) {
  const filePath = getHistoryFilePath(rootDir)
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0 && !isSensitiveHistoryEntry(entry),
    )
  } catch {
    return []
  }
}

export function writePromptHistory(rootDir: string, entries: string[]) {
  const filePath = getHistoryFilePath(rootDir)
  mkdirSync(getPaths(rootDir).stateDir, { recursive: true })
  const safeEntries = entries.filter(entry => !isSensitiveHistoryEntry(entry))
  writeFileSync(filePath, JSON.stringify(safeEntries.slice(-CLI_HISTORY_LIMIT), null, 2), "utf8")
}

export function pushPromptHistory(history: string[], line: string) {
  const trimmed = line.trim()
  if (!trimmed || trimmed === "/exit" || trimmed === "/quit" || isSensitiveHistoryEntry(trimmed)) return history
  return [...history.filter(entry => entry !== trimmed), trimmed].slice(-CLI_HISTORY_LIMIT)
}

export function createPromptHistory(rootDir: string): PromptHistory {
  return {
    items: readPromptHistory(rootDir),
    index: -1,
    draft: "",
  }
}

export function commitPromptHistory(rootDir: string, history: PromptHistory, line: string) {
  history.items = pushPromptHistory(history.items, line)
  history.index = -1
  history.draft = ""
  writePromptHistory(rootDir, history.items)
}

export function historyUp(history: PromptHistory, currentInput: string) {
  if (history.items.length === 0) return currentInput
  if (history.index === -1) {
    history.draft = currentInput
    history.index = history.items.length - 1
  } else if (history.index > 0) {
    history.index -= 1
  }
  return history.items[history.index] ?? currentInput
}

export function historyDown(history: PromptHistory) {
  if (history.index === -1) return history.draft
  if (history.index < history.items.length - 1) {
    history.index += 1
    return history.items[history.index] ?? history.draft
  }
  history.index = -1
  return history.draft
}
