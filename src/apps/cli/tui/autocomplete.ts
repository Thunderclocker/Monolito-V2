import { getDefaultMcpServers } from "../../../core/mcp/client.ts"
import { listTools } from "../../../core/tools/registry.ts"
import type { CompletionMatch } from "./types.ts"

export const INTERACTIVE_COMMANDS = [
  "/help", "/new", "/status", "/sessions", "/tool", "/mcp", "/model", "/channels", "/history",
  "/cost", "/compact", "/stats", "/doctor", "/config", "/quit", "/exit", "/stop",
]
export const MCP_SUBCOMMANDS = ["tools", "resources", "read", "call"]
export const COMPACT_SUBCOMMANDS: string[] = []
export const CONFIG_SUBCOMMANDS = ["show", "set"]

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
  const toolNames = listTools().map(tool => tool.name).sort()
  const mcpServers = Object.keys(getDefaultMcpServers(rootDir)).sort()

  return (line: string): CompletionMatch => {
    const tokens = getTokensForCompletion(line)
    if (tokens.length === 0) return [INTERACTIVE_COMMANDS, ""]

    const [command, subcommand = "", third = ""] = tokens

    // Typing just "/" shows all commands
    if (command === "/") return [INTERACTIVE_COMMANDS, "/"]

    if (tokens.length === 1) return completeToken(command, INTERACTIVE_COMMANDS)

    switch (command) {
      case "/tool":
        if (tokens.length === 2) return completeToken(subcommand, toolNames)
        return [[], line]
      case "/mcp":
        if (tokens.length === 2) return completeToken(subcommand, MCP_SUBCOMMANDS)
        if (tokens.length === 3 && MCP_SUBCOMMANDS.includes(subcommand)) {
          return completeToken(third, mcpServers)
        }
        return [[], line]
      case "/model":
        return [[], line]
      case "/compact":
        if (tokens.length === 2) return [["(max-messages)"], subcommand]
        return [[], line]
      case "/config":
        if (tokens.length === 2) return completeToken(subcommand, CONFIG_SUBCOMMANDS)
        if (tokens.length === 3 && subcommand === "set") return [["(field)"], third]
        return [[], line]
      case "/new":
      case "/stats":
      case "/doctor":
      case "/cost":
      case "/sessions":
      case "/help":
      case "/quit":
      case "/exit":
      case "/stop":
        return [[], line]
      default:
        return [[], line]
    }
  }
}
