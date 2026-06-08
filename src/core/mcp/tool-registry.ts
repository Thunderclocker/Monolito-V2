// MCP tool registry: dynamic per-server tool generation + factory.
// FC parity: extraído de mcpClient.ts upstream. Cachea listTools() por server.

import type { McpClient } from "./client.ts"

export type McpToolDescriptor = {
  server: string
  name: string
  description: string
  inputSchema: unknown
}

type ServerEntry = {
  client: McpClient
  tools: McpToolDescriptor[]
  cachedAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000  // 5 min
const serverRegistry = new Map<string, ServerEntry>()

/** Lista tools de un server, con cache. */
export async function listMcpTools(server: string, client: McpClient, forceRefresh = false): Promise<McpToolDescriptor[]> {
  const now = Date.now()
  const entry = serverRegistry.get(server)
  if (!forceRefresh && entry && (now - entry.cachedAt) < CACHE_TTL_MS && entry.client === client) {
    return entry.tools
  }
  const rawTools = (await client.listTools()) as any[]
  const tools: McpToolDescriptor[] = rawTools.map((t: any) => ({
    server,
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
  }))
  serverRegistry.set(server, { client, tools, cachedAt: now })
  return tools
}

/** Limpia cache de un server específico. */
export function clearMcpServerCache(server: string): void {
  serverRegistry.delete(server)
}

/** Limpia toda la cache. */
export function clearAllMcpCaches(): void {
  serverRegistry.clear()
}

/** Lista todos los servers cacheados. */
export function getCachedMcpServers(): string[] {
  return Array.from(serverRegistry.keys())
}
