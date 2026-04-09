import { homedir } from "node:os"
import type { AgentEvent, SessionSummary } from "../ipc/protocol.ts"

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  bold: "\u001b[1m",
}

export type ToolRenderTone = "neutral" | "info" | "success" | "error"

export type ToolRenderLine = {
  label: string
  tone: ToolRenderTone
  text: string
  detail?: string
}

export type TaskNotificationSummary = {
  agentId?: string
  status?: string
  summary?: string
  result?: string
  usage?: {
    totalTokens?: number
    durationMs?: number
  }
}

export function renderToolStartText(line: ToolRenderLine, detailPrefix = "  └─ ") {
  return [line.text, line.detail ? `${detailPrefix}${line.detail}` : undefined].filter(Boolean).join("\n")
}

export function parseTaskNotification(text: string): TaskNotificationSummary | null {
  const normalized = text.trim()
  if (!normalized.startsWith("<task-notification>") || !normalized.endsWith("</task-notification>")) return null

  const readTag = (tag: string) => normalized.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim()
  const totalTokensRaw = readTag("total_tokens")
  const durationMsRaw = readTag("duration_ms")
  const totalTokens = totalTokensRaw && /^\d+$/.test(totalTokensRaw) ? Number.parseInt(totalTokensRaw, 10) : undefined
  const durationMs = durationMsRaw && /^\d+$/.test(durationMsRaw) ? Number.parseInt(durationMsRaw, 10) : undefined

  return {
    agentId: readTag("task-id"),
    status: readTag("status"),
    summary: readTag("summary"),
    result: readTag("result"),
    usage: totalTokens !== undefined || durationMs !== undefined ? { totalTokens, durationMs } : undefined,
  }
}

export function truncate(text: string, max = 180) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1).trimEnd()}...`
}

export function stringify(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function stringifyPretty(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function record(input: unknown) {
  const value =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null
  return value
}

function getString(value: Record<string, unknown> | null, key: string) {
  const item = value?.[key]
  return typeof item === "string" && item.length > 0 ? item : undefined
}

function getNumber(value: Record<string, unknown> | null, key: string) {
  const item = value?.[key]
  return typeof item === "number" && Number.isFinite(item) ? item : undefined
}

function cleanShellCommand(command: string) {
  const trimmed = command.trim()
  const shellMatch = trimmed.match(/^(?:bash|zsh|sh)\s+-lc\s+(['"])([\s\S]*)\1$/)
  return shellMatch?.[2]?.trim() || trimmed
}

function shellWords(command: string) {
  const words = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return words.map(word => word.replace(/^(['"])([\s\S]*)\1$/, "$2"))
}

function humanizePath(value: string) {
  const home = homedir()
  if (value === home) return "~"
  if (value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`
  return value
}

function getLastShellTarget(command: string) {
  const words = shellWords(command)
  const positional = words.slice(1).filter(word => !word.startsWith("-"))
  return humanizePath(positional.at(-1) ?? ".")
}

function detectBashArtifact(command: string) {
  const normalized = cleanShellCommand(command)
  const redirect = normalized.match(/(?:^|\s)-o\s+(\S+)/)
  if (redirect) return humanizePath(redirect[1]!.replace(/^['"]|['"]$/g, ""))
  const chainedFile = normalized.match(/(?:cat|file|ls|stat)\s+(\S+\.(?:jpg|jpeg|png|gif|webp|pdf|txt|json|mp4|mp3|ogg|wav))/i)
  if (chainedFile) return humanizePath(chainedFile[1]!.replace(/^['"]|['"]$/g, ""))
  return null
}

function shellCommandDisplay(command: string) {
  const home = homedir()
  return cleanShellCommand(command).split(home).join("~")
}

function classifyShellCommand(command: string) {
  const cleaned = cleanShellCommand(command)
  if (/[|;&]|\|\|/.test(cleaned)) {
    if (/\b(curl|wget)\b/.test(cleaned)) return { verb: "Fetching", target: "remote/local endpoint" }
    if (/\b(ls|tree|find)\b/.test(cleaned)) return { verb: "Listing", target: "files" }
    if (/\b(ss|lsof|netstat|ps|systemctl|docker)\b/.test(cleaned)) return { verb: "Inspecting", target: "system state" }
    if (/\b(rg|grep)\b/.test(cleaned)) return { verb: "Searching", target: "results" }
    return { verb: "Running command", target: "command" }
  }
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/.test(cleaned)) {
    return { verb: "Running tests", target: cleaned }
  }
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|build|compile|lint|typecheck)\b/.test(cleaned)) {
    return { verb: /(\s|^)(build|compile)\b/.test(cleaned) ? "Building" : "Running checks", target: cleaned }
  }
  if (/^(cargo|go|pytest|vitest|jest|mocha|node\s+--test)\b/.test(cleaned)) {
    return { verb: "Running tests", target: cleaned }
  }
  if (/^(rg|grep|find)\b/.test(cleaned)) {
    return { verb: "Searching", target: getLastShellTarget(cleaned) }
  }
  if (/^ls\b/.test(cleaned)) {
    return { verb: "Listing", target: getLastShellTarget(cleaned) }
  }
  if (/^(tree)\b/.test(cleaned)) {
    return { verb: "Listing", target: getLastShellTarget(cleaned) }
  }
  if (/^(cat|sed|head|tail|wc)\b/.test(cleaned)) {
    return { verb: "Reading", target: getLastShellTarget(cleaned) }
  }
  if (/^(curl|wget)\b/.test(cleaned)) {
    return { verb: "Fetching", target: cleaned }
  }
  if (/^(apply_patch|git\s+apply|patch)\b/.test(cleaned)) {
    return { verb: "Applying patch", target: cleaned }
  }
  return { verb: "Running command", target: cleaned }
}

function countLines(text: string) {
  return text.split("\n").filter(Boolean).length
}

function outputPreview(value: Record<string, unknown> | null) {
  const stdout = getString(value, "stdout") ?? ""
  const stderr = getString(value, "stderr") ?? ""
  const text = stderr || stdout
  if (!text) return "no output"
  const label = stderr ? "stderr" : "stdout"
  return `${label} ${countLines(text)} lines\n${previewLines(text)}`
}

function getBoolean(value: Record<string, unknown> | null, key: string) {
  const item = value?.[key]
  return typeof item === "boolean" ? item : undefined
}

function getArray(value: Record<string, unknown> | null, key: string) {
  const item = value?.[key]
  return Array.isArray(item) ? item : undefined
}

function summarizeGenericRecord(value: Record<string, unknown> | null) {
  if (!value) return null

  const message = getString(value, "message")
  const status = getString(value, "status")
  const id = getString(value, "id") ?? getString(value, "agentId")
  const path = getString(value, "path") ?? getString(value, "file")
  const server = getString(value, "server")
  const room = getString(value, "room")
  const wing = getString(value, "wing")
  const key = getString(value, "key")
  const bytes = getNumber(value, "bytes")
  const pid = getNumber(value, "pid")

  const arrayCounts = [
    ["profiles", getArray(value, "profiles")],
    ["tasks", getArray(value, "tasks")],
    ["files", getArray(value, "filenames")],
    ["memories", getArray(value, "memories")],
    ["recent memories", getArray(value, "recentMemories")],
    ["wings", getArray(value, "wings")],
    ["rooms", getArray(value, "rooms")],
    ["resources", getArray(value, "resources")],
    ["tools", getArray(value, "tools")],
  ]
    .filter(([, arr]) => arr)
    .map(([label, arr]) => `${arr?.length ?? 0} ${label}`)

  const parts = [
    message,
    status ? `status ${status}` : undefined,
    id ? `id ${id}` : undefined,
    path ? humanizePath(path) : undefined,
    server,
    wing && room ? `${wing}/${room}${key ? ` · ${key}` : ""}` : undefined,
    typeof bytes === "number" ? `${bytes} bytes` : undefined,
    typeof pid === "number" ? `pid ${pid}` : undefined,
    ...arrayCounts,
  ].filter(Boolean)

  if (parts.length > 0) return truncate(parts.join(" · "), 180)

  const keys = Object.keys(value)
  if (keys.length > 0) {
    return truncate(`keys: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", ..." : ""}`, 180)
  }

  return null
}

export function summarizeInput(tool: string, input: unknown) {
  const value = record(input)
  if (!value) return truncate(stringify(input), 140)

  switch (tool) {
    case "Bash":
      return truncate(cleanShellCommand(getString(value, "command") ?? stringify(value)), 140)
    case "Read":
    case "Write":
      return truncate(String(value.path ?? value.file_path ?? "?"), 140)
    case "Edit":
      return truncate(`${value.path ?? value.file_path ?? "?"} replace`, 140)
    case "Glob":
      return truncate(`${value.pattern ?? "*"} @ ${value.path ?? "."}`, 140)
    case "Grep":
      return truncate(`${value.pattern ?? "?"} @ ${value.path ?? "."}`, 140)
    default:
      return summarizeGenericRecord(value) ?? truncate(stringify(value), 140)
  }
}

export function previewLines(text: string, maxLines = 8, maxWidth = 100) {
  const lines = text.split("\n").filter(Boolean)
  const visible = lines.slice(0, maxLines).map(line => truncate(line, maxWidth))
  if (lines.length > maxLines) {
    visible.push(`... (${lines.length - maxLines} more lines)`)
  }
  return visible.join("\n")
}

export function summarizeOutput(tool: string, output: unknown) {
  const value = record(output)

  if (!value) return truncate(stringify(output), 180)
  if (typeof value.error === "string" && value.error.length > 0) {
    return value.error
  }
  if (tool === "Bash") {
    const stdout = typeof value.stdout === "string" ? value.stdout : ""
    const stderr = typeof value.stderr === "string" ? value.stderr : ""
    const text = stdout || stderr || stringify(value)
    const lineCount = text.split("\n").filter(Boolean).length
    const label = stderr ? "stderr" : "stdout"
    return `${label}${lineCount > 0 ? ` ${lineCount} lines` : ""}\n${previewLines(text)}`
  }
  if (tool === "Read") {
    const content = typeof value.content === "string" ? value.content : ""
    return `${value.path ?? "?"}\n${previewLines(content)}`
  }
  if (tool === "Write") {
    return `${value.type === "update" ? "updated" : "created"} ${value.path ?? "?"} (${value.bytes ?? "?"} bytes)`
  }
  if (tool === "Edit") {
    return `edited ${value.path ?? "?"} (${value.replaced ?? "?"} replacement${value.replaced === 1 ? "" : "s"})`
  }
  if (tool === "Glob" || tool === "Grep") {
    const prefix =
      tool === "Glob"
        ? `${value.numFiles ?? 0} matches`
        : `${value.mode ?? "files_with_matches"} ${value.numFiles ?? value.numMatches ?? 0}`
    const filenames = Array.isArray(value.filenames) ? value.filenames.slice(0, 6).join("\n") : ""
    return filenames ? `${prefix}\n${filenames}` : prefix
  }
  if (tool === "pwd") {
    return String(value.cwd ?? stringify(value))
  }
  return summarizeGenericRecord(value) ?? truncate(stringify(value), 180)
}

export function renderToolStart(tool: string, input: unknown): ToolRenderLine {
  const value = record(input)
  switch (tool) {
    case "Bash": {
      const command = getString(value, "command")
      if (!command) {
        return {
          label: "",
          tone: "info",
          text: "Running command...",
        }
      }
      const classified = classifyShellCommand(command ?? "")
      return {
        label: "",
        tone: "info",
        text: `${classified.verb} ${truncate(classified.target || "command", 140)}...`,
        detail: command ? truncate(shellCommandDisplay(command), 180) : undefined,
      }
    }
    case "Read":
      return {
        label: "",
        tone: "info",
        text: "Reading 1 file...",
        detail: humanizePath(getString(value, "path") ?? "file"),
      }
    case "Glob":
      return {
        label: "",
        tone: "info",
        text: `Searching ${humanizePath(getString(value, "path") ?? ".")} for ${truncate(getString(value, "pattern") ?? "*", 80)}...`,
        detail: `glob ${truncate(getString(value, "pattern") ?? "*", 140)}`,
      }
    case "Grep":
      return {
        label: "",
        tone: "info",
        text: `Searching ${humanizePath(getString(value, "path") ?? ".")} for ${truncate(getString(value, "pattern") ?? "pattern", 80)}...`,
        detail: `grep ${truncate(getString(value, "pattern") ?? "pattern", 140)}`,
      }
    case "Write":
      return {
        label: "",
        tone: "info",
        text: `Writing ${humanizePath(getString(value, "path") ?? "file")}...`,
        detail: humanizePath(getString(value, "path") ?? "file"),
      }
    case "Edit":
      return {
        label: "",
        tone: "info",
        text: `Editing ${humanizePath(getString(value, "path") ?? "file")}...`,
        detail: humanizePath(getString(value, "path") ?? "file"),
      }
    case "ListMcpResourcesTool":
      return { label: "mcp", tone: "info", text: `Listing MCP resources from ${getString(value, "server") ?? "demo"}...`, detail: getString(value, "server") ?? "demo" }
    case "ReadMcpResourceTool":
      return { label: "mcp", tone: "info", text: `Reading MCP resource ${getString(value, "uri") ?? ""}...`.trim(), detail: getString(value, "uri") }
    case "pwd":
      return { label: "", tone: "info", text: "Reading workspace directory..." }
    case "list_files":
      return {
        label: "",
        tone: "info",
        text: `Listing ${humanizePath(getString(value, "path") ?? ".")}...`,
        detail: humanizePath(getString(value, "path") ?? "."),
      }
    case "AgentSpawn":
      return {
        label: "",
        tone: "info",
        text: `Launching agent ${truncate(getString(value, "description") ?? getString(value, "profileId") ?? "worker", 80)}...`,
        detail: `${getString(value, "profileId") ?? "default"} · ${truncate(getString(value, "task") ?? "", 140)}`,
      }
    case "AgentSendMessage":
      return {
        label: "",
        tone: "info",
        text: `Sending follow-up to ${truncate(getString(value, "to") ?? "agent", 80)}...`,
        detail: truncate(getString(value, "message") ?? "", 180),
      }
    case "AgentStop":
      return {
        label: "",
        tone: "info",
        text: `Stopping agent ${truncate(getString(value, "agentId") ?? "agent", 80)}...`,
      }
    case "ProfileCreate":
      return {
        label: "",
        tone: "info",
        text: `Creating profile ${truncate(getString(value, "id") ?? "profile", 80)}...`,
        detail: truncate(getString(value, "description") ?? getString(value, "name") ?? "", 140),
      }
    case "WorkspaceRead":
      return {
        label: "",
        tone: "info",
        text: `Reading ${getString(value, "file") ?? "workspace file"}...`,
      }
    case "WorkspaceWrite":
      return {
        label: "",
        tone: "info",
        text: `Updating ${getString(value, "file") ?? "workspace file"}...`,
      }
    case "WorkspaceMemoryFiling":
      return {
        label: "",
        tone: "info",
        text: `Saving memory in ${(getString(value, "wing") ?? "PRIVATE").toUpperCase()}/${getString(value, "room") ?? "general"}...`,
        detail: getString(value, "key") ?? undefined,
      }
    case "WorkspaceMemoryRecall":
      return {
        label: "",
        tone: "info",
        text: "Recalling workspace memory...",
        detail: [
          getString(value, "wing"),
          getString(value, "room"),
          getString(value, "key"),
          getString(value, "query"),
        ].filter(Boolean).join(" · ") || undefined,
      }
    default:
      return { label: "tool", tone: "info", text: `${tool}: ${summarizeInput(tool, input)}` }
  }
}

export function renderToolFinish(tool: string, ok: boolean, output: unknown): ToolRenderLine {
  const value = record(output)
  const tone: ToolRenderTone = ok ? "success" : "error"
  const label = ok ? "done" : "error"
  if (!ok) {
    const message = getString(value, "error") ?? summarizeOutput(tool, output)
    return { label, tone, text: `${tool} failed: ${truncate(message, 220)}` }
  }

  switch (tool) {
    case "Bash": {
      if (value?.background === true) {
        const pid = getNumber(value, "pid")
        const outputPath = getString(value, "outputPath")
        const command = getString(value, "command")
        return {
          label,
          tone,
          text: `Command running in background${pid ? ` pid ${pid}` : ""}${outputPath ? ` · log ${outputPath}` : ""}${command ? ` · ${truncate(cleanShellCommand(command), 80)}` : ""}`,
        }
      }
      const exitCode = getNumber(value, "exitCode")
      const failed = typeof exitCode === "number" && exitCode !== 0
      if (failed) return { label: "error", tone: "error", text: `Command exited ${exitCode}` }
      const stdout = getString(value, "stdout") ?? ""
      const stderr = getString(value, "stderr") ?? ""
      const command = getString(value, "command") ?? ""
      const artifact = command ? detectBashArtifact(command) : null
      if (!stdout.trim() && !stderr.trim() && artifact) {
        return { label, tone, text: `Command completed: produced ${artifact}` }
      }
      return { label: failed ? "error" : label, tone: failed ? "error" : tone, text: failed ? `Command exit ${exitCode}: no output` : "Command completed: no output" }
    }
    case "Read": {
      return { label, tone, text: `Read ${humanizePath(getString(value, "path") ?? "file")}` }
    }
    case "Glob": {
      return { label, tone, text: `Found ${getNumber(value, "numFiles") ?? 0} files` }
    }
    case "Grep": {
      const count = getNumber(value, "numFiles") ?? getNumber(value, "numMatches") ?? 0
      return { label, tone, text: `Search results: ${count}` }
    }
    case "Write":
      return { label, tone, text: `${value?.type === "update" ? "Updated" : "Created"} ${getString(value, "path") ?? "file"} (${getNumber(value, "bytes") ?? "?"} bytes)` }
    case "Edit":
      {
        const replaced = getNumber(value, "replaced")
        return { label, tone, text: `Edited ${getString(value, "path") ?? "file"} (${replaced ?? "?"} replacement${replaced === 1 ? "" : "s"})` }
      }
    case "ListMcpResourcesTool":
      return { label: "mcp", tone, text: summarizeOutput(tool, output) }
    case "ReadMcpResourceTool":
      return { label: "mcp", tone, text: summarizeOutput(tool, output) }
    case "pwd":
      return { label, tone, text: String(value?.cwd ?? stringify(output)) }
    case "list_files":
      return { label, tone, text: summarizeOutput(tool, output) }
    case "AgentSpawn": {
      const status = getString(value, "status") ?? "unknown"
      const agentId = getString(value, "agentId") ?? "agent"
      if (status === "spawned") return { label, tone, text: `Agent ${agentId} started` }
      if (status === "completed") return { label, tone, text: `Agent ${agentId} completed` }
      if (status === "failed") return { label: "error", tone: "error", text: `Agent ${agentId} failed` }
      if (status === "killed") return { label: "error", tone: "error", text: `Agent ${agentId} stopped` }
      return { label, tone, text: `Agent ${agentId}: ${status}` }
    }
    case "AgentSendMessage":
      return { label, tone, text: truncate(getString(value, "message") ?? "Message sent to agent.", 180) }
    case "AgentStop":
      return { label, tone, text: truncate(getString(value, "message") ?? "Agent stopped.", 180) }
    case "ProfileCreate":
      return { label, tone, text: `Profile ${getString(value, "id") ?? "profile"} created` }
    case "WorkspaceRead":
      return { label, tone, text: `Read ${getString(value, "file") ?? "workspace file"}` }
    case "WorkspaceWrite":
      return { label, tone, text: `Updated ${getString(value, "file") ?? "workspace file"}` }
    case "WorkspaceMemoryFiling": {
      const shared = getBoolean(value, "shared") === true
      const wing = getString(value, "wing") ?? (shared ? "SHARED" : "PRIVATE")
      const room = getString(value, "room") ?? "general"
      const key = getString(value, "key")
      return { label, tone, text: `Memory saved in ${wing}/${room}${key ? ` · ${key}` : ""}` }
    }
    case "WorkspaceMemoryRecall": {
      const memories = Array.isArray(value?.memories) ? value.memories.length : undefined
      const recent = Array.isArray(value?.recentMemories) ? value.recentMemories.length : undefined
      const wings = Array.isArray(value?.wings) ? value.wings.length : undefined
      if (typeof memories === "number") return { label, tone, text: `Memory recall: ${memories} result${memories === 1 ? "" : "s"}` }
      if (typeof recent === "number") return { label, tone, text: `Memory recall: ${recent} recent item${recent === 1 ? "" : "s"}${typeof wings === "number" ? ` across ${wings} wing${wings === 1 ? "" : "s"}` : ""}` }
      return { label, tone, text: "Memory recall completed" }
    }
    default:
      return { label, tone, text: `${tool}: ${summarizeOutput(tool, output)}` }
  }
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

function formatUsage(
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  },
) {
  if (!usage) return "tokens: n/d"
  const parts: string[] = []
  if (typeof usage.inputTokens === "number") parts.push(`in ${usage.inputTokens}`)
  if (typeof usage.outputTokens === "number") parts.push(`out ${usage.outputTokens}`)
  if (typeof usage.totalTokens === "number") parts.push(`total ${usage.totalTokens}`)
  return parts.length > 0 ? parts.join(" · ") : "tokens: n/d"
}

export class ToolUseRenderer {
  private pendingAssistantToolResults: string[] = []
  private pendingMcpCall: string | null = null
  private pendingBashCommand: string | null = null

  private isInternalToolEnvelope(text: string) {
    return /^(TOOL_USE|TOOL_RESULT|TOOL_CALL_ERROR)\b/.test(text.trim())
  }

  private summarizeMcpAssistant(text: string) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (Array.isArray(parsed.content)) {
        const firstText = parsed.content.find(
          item => item && typeof item === "object" && (item as { type?: string }).type === "text",
        ) as { text?: string } | undefined
        if (typeof firstText?.text === "string") {
          return `${ANSI.cyan}mcp result${ANSI.reset} ${this.pendingMcpCall ?? ""} ${truncate(firstText.text, 140)}`.trim()
        }
      }
      if (Array.isArray(parsed.resources)) {
        const names = parsed.resources
          .slice(0, 5)
          .map(item => (item && typeof item === "object" ? String((item as { name?: unknown }).name ?? "?") : "?"))
          .join(", ")
        return `${ANSI.cyan}mcp result${ANSI.reset} ${names}`.trim()
      }
    } catch {}
    return null
  }

  render(event: AgentEvent) {
    switch (event.type) {
      case "session.created":
        return ""
      case "session.resumed":
        return ""
      case "state.changed":
        return ""
      case "message.received":
        {
          const taskNotification = parseTaskNotification(event.text)
          if (taskNotification) {
            const tone = taskNotification.status === "completed" ? ANSI.green : taskNotification.status === "failed" ? ANSI.red : ANSI.yellow
            const lines = [
              `${tone}agent${ANSI.reset} ${taskNotification.summary ?? "Agent update"}`,
              taskNotification.agentId ? `${ANSI.dim}  └─ id ${taskNotification.agentId}${ANSI.reset}` : "",
              taskNotification.result ? `${ANSI.dim}  └─ result${ANSI.reset}\n${taskNotification.result}` : "",
              taskNotification.usage
                ? `${ANSI.dim}${formatDuration(taskNotification.usage.durationMs ?? 0)} · ${taskNotification.usage.totalTokens ?? 0} tokens${ANSI.reset}`
                : "",
            ].filter(Boolean)
            return lines.join("\n")
          }
        }
        if (event.role === "user") {
          return `${ANSI.blue}you${ANSI.reset} ${event.text}`
        }
        if (this.isInternalToolEnvelope(event.text)) return ""
        if (this.pendingAssistantToolResults[0] === event.text) {
          this.pendingAssistantToolResults.shift()
          return ""
        }
        if (this.pendingBashCommand !== null && event.text.trim() === this.pendingBashCommand.trim()) {
          this.pendingBashCommand = null
          return `${ANSI.dim}  └─ ${event.text}${ANSI.reset}`
        }
        if (this.pendingMcpCall) {
          const summary = this.summarizeMcpAssistant(event.text)
          this.pendingMcpCall = null
          if (summary) return summary
        }
        return `${ANSI.bold}assistant${ANSI.reset} ${event.text}`
      case "turn.completed":
        return `${ANSI.dim}${formatDuration(event.durationMs)} · ${formatUsage(event.usage)}${ANSI.reset}`
      case "tool.start": {
        const line = renderToolStart(event.tool, event.input)
        const prefix = line.label ? `${ANSI.yellow}${line.label}${ANSI.reset} ` : ""
        if (event.tool === "Bash" && line.detail) {
          this.pendingBashCommand = line.detail
        }
        return `${prefix}${ANSI.dim}${renderToolStartText(line)}${ANSI.reset}`
      }
      case "tool.finish": {
        const line = renderToolFinish(event.tool, event.ok, event.output)
        const prefix = line.tone === "error" ? `${ANSI.red}${line.label}${ANSI.reset}` : `${ANSI.green}${line.label}${ANSI.reset}`
        if (event.tool === "Bash") this.pendingBashCommand = null
        if (event.ok) {
          this.pendingAssistantToolResults.push(stringifyPretty(event.output))
        }
        if (event.ok && record(event.output)?.background === true) return `${prefix} ${line.text}`
        if (line.text) {
          const treePrefix = `${ANSI.dim}  └─${ANSI.reset} `
          return `${prefix} ${treePrefix}${line.text}`
        }
        return ""
      }
      case "mcp.connected":
        return `${ANSI.cyan}mcp${ANSI.reset} connected ${event.server}`
      case "mcp.called":
        this.pendingMcpCall = `${event.server}.${event.tool}`
        return `${ANSI.cyan}mcp${ANSI.reset} ${event.server}.${event.tool}`
      case "error":
        return `${ANSI.red}error${ANSI.reset} ${event.error}`
    }
  }
}

export function formatSessionRow(session: SessionSummary) {
  return `${session.id}  ${session.state}  ${session.updatedAt}  ${session.title}`
}
