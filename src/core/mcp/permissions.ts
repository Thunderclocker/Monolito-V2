// MCP permission gate: enforces isOpenWorld + write-tool permission for MCP tools.
// upstream parity: extraído de mcpClient.ts upstream. Lee policyConfigZod
// para reglas específicas de MCP.

import { readConfigWing } from "../session/store.ts"
import type { ToolContext } from "../tools/internal.ts"

export type McpPermissionDecision = "allow" | "ask" | "deny"

export type McpPolicy = {
  permissions: {
    mode: "default" | "acceptEdits" | "bypassPermissions"
    rules: Array<{ tool?: string; action: McpPermissionDecision; input?: string }>
  }
}

const SESSION_CACHE = new Map<string, McpPolicy | null>()

function readMcpPolicy(rootDir: string): McpPolicy | null {
  if (SESSION_CACHE.has(rootDir)) return SESSION_CACHE.get(rootDir) ?? null
  try {
    const raw = readConfigWing(rootDir, "CONF_POLICY" as any) as unknown
    if (typeof raw !== "string" || !raw) {
      SESSION_CACHE.set(rootDir, null)
      return null
    }
    const policy = JSON.parse(raw) as McpPolicy
    SESSION_CACHE.set(rootDir, policy)
    return policy
  } catch {
    SESSION_CACHE.set(rootDir, null)
    return null
  }
}

export function clearMcpPermissionCache(rootDir?: string): void {
  if (rootDir) SESSION_CACHE.delete(rootDir)
  else SESSION_CACHE.clear()
}

/** Verifica si el MCP tool tiene permission grant. Default-allow si no hay policy. */
export async function isMcpPermissionEnabled(
  context: ToolContext,
  server: string,
  toolName: string,
): Promise<boolean> {
  const policy = readMcpPolicy(context.rootDir)
  if (!policy) return true
  if (policy.permissions.mode === "bypassPermissions") return true
  // Buscar rules explícitas
  const toolKey = `Mcp:${server}:${toolName}`
  for (const rule of policy.permissions.rules) {
    if (rule.tool && rule.tool === toolKey) {
      return rule.action === "allow"
    }
  }
  return true  // default-allow
}
