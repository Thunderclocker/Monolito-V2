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

type McpPolicyState =
  | { kind: "absent" }
  | { kind: "valid"; policy: McpPolicy }
  | { kind: "invalid" }

const SESSION_CACHE = new Map<string, McpPolicyState>()

function isMcpPolicy(value: unknown): value is McpPolicy {
  if (!value || typeof value !== "object") return false
  const permissions = (value as { permissions?: unknown }).permissions
  if (!permissions || typeof permissions !== "object") return false

  const { mode, rules } = permissions as { mode?: unknown; rules?: unknown }
  if (mode !== "default" && mode !== "acceptEdits" && mode !== "bypassPermissions") return false
  if (!Array.isArray(rules)) return false

  return rules.every(rule => {
    if (!rule || typeof rule !== "object") return false
    const candidate = rule as { tool?: unknown; action?: unknown; input?: unknown }
    if (candidate.tool !== undefined && typeof candidate.tool !== "string") return false
    if (candidate.input !== undefined && typeof candidate.input !== "string") return false
    return candidate.action === "allow" || candidate.action === "ask" || candidate.action === "deny"
  })
}

function readMcpPolicy(rootDir: string): McpPolicyState {
  const cached = SESSION_CACHE.get(rootDir)
  if (cached) return cached

  try {
    const raw = readConfigWing(rootDir, "CONF_POLICY" as any) as unknown
    if (typeof raw !== "string" || !raw.trim()) {
      const state: McpPolicyState = { kind: "absent" }
      SESSION_CACHE.set(rootDir, state)
      return state
    }

    const parsed = JSON.parse(raw) as unknown
    const state: McpPolicyState = isMcpPolicy(parsed)
      ? { kind: "valid", policy: parsed }
      : { kind: "invalid" }
    SESSION_CACHE.set(rootDir, state)
    return state
  } catch {
    const state: McpPolicyState = { kind: "invalid" }
    SESSION_CACHE.set(rootDir, state)
    return state
  }
}

export function clearMcpPermissionCache(rootDir?: string): void {
  if (rootDir) SESSION_CACHE.delete(rootDir)
  else SESSION_CACHE.clear()
}

/** Verifica si el MCP tool tiene permission grant. Default-allow sólo si no hay policy. */
export async function isMcpPermissionEnabled(
  context: ToolContext,
  server: string,
  toolName: string,
): Promise<boolean> {
  const state = readMcpPolicy(context.rootDir)
  if (state.kind === "absent") return true
  if (state.kind === "invalid") return false

  const policy = state.policy
  if (policy.permissions.mode === "bypassPermissions") return true
  // Buscar rules explícitas
  const toolKey = `Mcp:${server}:${toolName}`
  for (const rule of policy.permissions.rules) {
    if (rule.tool && rule.tool === toolKey) {
      return rule.action === "allow"
    }
  }
  return true  // default-allow para policy válida sin regla específica
}
