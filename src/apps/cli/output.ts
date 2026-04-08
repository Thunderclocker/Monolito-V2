import { stdout } from "node:process"
import type { SessionRecord } from "../../core/ipc/protocol.ts"

export type CliError = Error & {
  code?: string
}

export function writeLine(line: string) {
  stdout.write(`${line}\n`)
}

export function writeBlock(text: string) {
  stdout.write(text.endsWith("\n") ? text : `${text}\n`)
}

export function formatHistory(session: SessionRecord, limit = 20) {
  return session.worklog.slice(-limit).map(entry => `${entry.at} [${entry.type}] ${entry.summary}`).join("\n")
}

export function handleCliFailure(error: unknown): never {
  const typed = error as CliError
  if (typed.code !== "REMOTE_ERROR") {
    writeLine(`error: ${typed?.message || "Unknown error"}`)
  }
  process.exit(typed.code === "SESSION_BUSY" ? 2 : 1)
}
