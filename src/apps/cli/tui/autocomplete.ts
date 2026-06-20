import { getDefaultMcpServers } from "../../../core/mcp/client.ts"
import { listTools } from "../../../core/tools/registry.ts"
import type { CompletionMatch } from "./types.ts"

export const INTERACTIVE_COMMANDS = [
  "/help", "/new", "/clear", "/reset", "/model", "/think", "/channels", "/update", "/dashboard", "/quit", "/exit", "/stop", "/minimax",
]

export function getTokensForCompletion(line: string) {
  const endsWithSpace = /\s$/.test(line)
  const trimmed = line.trimStart()
  const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/)
  if (endsWithSpace) tokens.push("")
  return tokens
}

export function completeToken(input: string, options: string[]): CompletionMatch {
  const matches = options.filter(option => option.startsWith(input)).sort()
  return [matches.length > 0 ? matches : options.sort(), input]
}

export function findCommonPrefix(values: string[]) {
  if (values.length === 0) return ""
  let prefix = values[0] ?? ""
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1)
    }
  }
  return prefix
}

export function applyCompletion(input: string, cursor: number, token: string, replacement: string) {
  if (!token) return { input, cursor }
  const before = input.slice(0, cursor)
  const after = input.slice(cursor)
  if (!before.endsWith(token)) return { input, cursor }
  const nextInput = `${before.slice(0, before.length - token.length)}${replacement}${after}`
  return {
    input: nextInput,
    cursor: before.length - token.length + replacement.length,
  }
}

export function createInteractiveCompleter(rootDir: string) {
  return (line: string): CompletionMatch => {
    const tokens = getTokensForCompletion(line)
    if (tokens.length === 0) return [INTERACTIVE_COMMANDS, ""]

    const [command] = tokens

    // Typing just "/" shows all commands
    if (command === "/") return [INTERACTIVE_COMMANDS, "/"]

    if (tokens.length === 1) return completeToken(command, INTERACTIVE_COMMANDS)

    switch (command) {
      case "/think": {
        const last = tokens[tokens.length - 1] ?? ""
        const options = ["off", "low", "medium", "high"]
        return completeToken(last, options)
      }
      case "/model":
      case "/new":
      case "/clear":
      case "/reset":
      case "/channels":
      case "/help":
      case "/update":
      case "/dashboard":
      case "/quit":
      case "/exit":
      case "/stop":
      case "/minimax":
        return [[], line]
      default:
        return [[], line]
    }
  }
}
