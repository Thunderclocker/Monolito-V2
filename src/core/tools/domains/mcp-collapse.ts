// MCP tool result classification for UI collapsibility + truncation token budget.
// upstream parity: subset del classifyForCollapse + truncateMcpContent.
//
// Collapse classes:
//   - "search": grep-like read-only (list_users, search_repos, etc.) → colapsa a count
//   - "read": single-resource read (get_user, get_repo) → muestra inline
//   - "write": mutates (create_*, update_*, delete_*) → muestra expandido
//   - "default": no classification → expandido

const SEARCH_PATTERNS = [
  /^(list|search|find|query|fetch_)/i,
]

const READ_PATTERNS = [
  /^get_/i,  // single-item reads
  /^read_/i,
  /^fetch_(?!_)/i,  // fetch_X (but not fetch_list, etc.)
]

const WRITE_PATTERNS = [
  /^(create|update|delete|remove|set|add|put|post|patch)/i,
  /^(send|publish|deploy|merge|close|reopen|assign|comment|review|approve)/i,
]

const SERVER_ALLOWLISTS: Record<string, RegExp[]> = {
  slack: [/^slack_/],
  github: [/^github_/],
  linear: [/^linear_/],
  sentry: [/^sentry_/],
  notion: [/^notion_/],
  gmail: [/^gmail_/],
}

export type CollapseClass = "search" | "read" | "write" | "default"

export function classifyMcpToolForCollapse(toolName: string, serverName?: string): CollapseClass {
  // Server-specific allowlists
  if (serverName && SERVER_ALLOWLISTS[serverName]) {
    const allowed = SERVER_ALLOWLISTS[serverName]
    if (allowed.some(p => p.test(toolName))) {
      // Continue to general classification
    }
  }
  if (WRITE_PATTERNS.some(p => p.test(toolName))) return "write"
  if (SEARCH_PATTERNS.some(p => p.test(toolName))) return "search"
  if (READ_PATTERNS.some(p => p.test(toolName))) return "read"
  return "default"
}

/** Normaliza tool names entre kebab-case, snake_case y camelCase. */
export function normalizeMcpToolName(name: string): string {
  return name
    .replace(/-/g, "_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
}

export function isReadOnlyMcpTool(toolName: string): boolean {
  const cls = classifyMcpToolForCollapse(toolName)
  return cls === "search" || cls === "read"
}
