/**
 * Pretty formatters for local slash command output.
 */

export type FormattedBlock = {
  type: "table" | "keyvalue" | "list" | "code" | "text"
  tone?: "neutral" | "success" | "error" | "info"
  content: string
}

function padRight(s: string, n: number) {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}

function padLeft(s: string, n: number) {
  return s.length >= n ? s : " ".repeat(n - s.length) + s
}

export function formatSessionsTable(rows: Array<{ id: string; state: string; title: string }>): FormattedBlock {
  const lines: string[] = []
  const idCol = Math.max(36, ...rows.map(r => r.id.length))
  const stateCol = 8
  lines.push(`${padRight("SESSION ID", idCol)} ${padRight("STATE", stateCol)} TITLE`)
  lines.push(`${"—".repeat(idCol)} ${"—".repeat(stateCol)} ${"—".repeat(30)}`)
  for (const row of rows.slice(0, 50)) {
    const shortId = row.id.length > idCol ? row.id.slice(0, idCol - 3) + "..." : row.id
    lines.push(`${padRight(shortId, idCol)} ${padRight(row.state, stateCol)} ${row.title || "(no title)"}`)
  }
  if (rows.length > 50) lines.push(`... and ${rows.length - 50} more`)
  return { type: "table", content: lines.join("\n") }
}

export function formatCostSummary(text: string): FormattedBlock {
  const lines = text.split("\n")
  const formatted = lines.map(line => {
    if (line.startsWith("Cost:")) return `  💰 ${line}`
    if (line.startsWith("Tokens:")) return `  📊 ${line}`
    if (line.startsWith("Cache:")) return `  💾 ${line}`
    if (line.startsWith("API:")) return `  ⏱  ${line}`
    if (line.startsWith("Tools:")) return `  🔧 ${line}`
    if (line.startsWith("Per model:")) return `  📋 ${line}`
    if (line.startsWith("  ")) return `    ${line.trim()}`
    return `  ${line}`
  })
  return { type: "list", tone: "info", content: formatted.join("\n") }
}

export function formatStats(text: string): FormattedBlock {
  const lines = text.split("\n")
  const formatted = lines.map(line => {
    const [key, ...rest] = line.split(":")
    if (rest.length > 0) return `  ${padRight(key + ":", 20)} ${rest.join(":")}`
    return `  ${line}`
  })
  return { type: "keyvalue", content: formatted.join("\n") }
}

export function formatDoctor(text: string): FormattedBlock {
  const lines = text.split("\n")
  const formatted = lines.map(line => {
    if (line.startsWith("===")) return `\n  ${line} `
    if (line.includes(": OK") || line.includes(": ok")) return `  ✅ ${line}`
    if (line.includes(": MISSING")) return `  ❌ ${line}`
    if (line.includes(": ERROR")) return `  ❌ ${line}`
    if (line.startsWith("Cost:")) return formatCostSummary(line).content
    return `  ${line}`
  })
  return { type: "list", tone: "info", content: formatted.join("\n") }
}

export function formatConfig(text: string): FormattedBlock {
  // Pretty-print JSON config
  try {
    const obj = JSON.parse(text)
    const lines: string[] = []
    for (const [key, value] of Object.entries(obj)) {
      if (key === "env") {
        for (const [envKey, envVal] of Object.entries(obj.env || {})) {
          lines.push(`  ${padRight(envKey, 28)} ${JSON.stringify(envVal)}`)
        }
      } else {
        lines.push(`  ${padRight(key, 20)} ${JSON.stringify(value)}`)
      }
    }
    return { type: "code", content: lines.join("\n") }
  } catch {
    return { type: "code", content: text }
  }
}

export function formatCompact(text: string): FormattedBlock {
  return { type: "text", tone: "success", content: `  🗜  ${text}` }
}

export function formatHistory(text: string): FormattedBlock {
  const lines = text.split("\n").slice(0, 30)
  const formatted = lines.map(line => {
    const match = line.match(/^(\S+ \S+)\s+\[(\w+)\]\s+(.*)/)
    if (match) {
      const [, time, type, summary] = match
      return `  ${padRight(time, 24)} ${padRight("[" + type + "]", 12)} ${summary}`
    }
    return `  ${line}`
  })
  if (text.split("\n").length > 30) formatted.push(`  ... (showing last 30 of ${text.split("\n").length})`)
  return { type: "list", content: formatted.join("\n") }
}

export function formatMcpTools(text: string): FormattedBlock {
  try {
    const tools = JSON.parse(text)
    const lines: string[] = []
    for (const tool of tools.slice(0, 50)) {
      const name = typeof tool === "string" ? tool : tool.name || "(unknown)"
      const desc = typeof tool === "object" ? (tool.description || "").slice(0, 50) : ""
      lines.push(`  ${padRight(name, 30)} ${desc}`)
    }
    return { type: "list", content: lines.join("\n") }
  } catch {
    return { type: "text", content: text }
  }
}

export function formatModelInfo(text: string): FormattedBlock {
  const lines = text.split("\n")
  const formatted = lines.map(line => {
    if (line.startsWith("  ")) return line
    if (line.includes(":")) {
      const [key, ...rest] = line.split(":")
      return `  ${padRight(key + ":", 16)} ${rest.join(":")}`
    }
    return `  ${line}`
  })
  return { type: "keyvalue", content: formatted.join("\n") }
}

export function formatHelp(): FormattedBlock {
  const commands = [
    ["/help", "Show this help"],
    ["/new", "Start a fresh session"],
    ["/sessions", "List all sessions"],
    ["/doctor", "Run system health check"],
    ["/update", "Fetch and fast-forward from origin"],
    ["/channels", "Interactive Telegram channel menu or text command"],
    ["/websearch", "Interactive web search menu"],
    ["/config [show|set]", "Show or set configuration"],
    ["/model", "Interactive model configuration menu"],
    ["/tool [name] [json]", "Run a tool directly"],
    ["/mcp tools [server]", "List MCP tools"],
    ["/stop", "Stop daemon and exit"],
    ["/quit /exit", "Exit CLI"],
  ]
  const lines = commands.map(([cmd, desc]) => `  ${padRight(cmd, 24)} ${desc}`)
  return { type: "list", tone: "neutral", content: lines.join("\n") }
}

export function renderFormattedBlock(block: FormattedBlock): string {
  switch (block.type) {
    case "table":
    case "code":
    case "keyvalue":
    case "list":
      return block.content
    case "text":
    default:
      return block.content
  }
}
