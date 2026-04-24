import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type JsonRpcResponse = {
  id?: string
  result?: unknown
  error?: { message?: string }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export type McpServerConfig =
  | { type: "stdio"; command: string[]; cwd: string }
  | { type: "sse"; url: string }

export type LegacyMcpServerConfig = Omit<Extract<McpServerConfig, { type: "stdio" }>, "type">

export type ResolvedMcpServerConfig = McpServerConfig | LegacyMcpServerConfig

export interface McpClient {
  initialize(): Promise<void>
  listTools(): Promise<unknown>
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  listResources(): Promise<unknown>
  readResource(uri: string): Promise<unknown>
  close(): void
}

function resolveMessage(message: JsonRpcResponse, pending: Map<string, PendingRequest>) {
  if (!message.id) return
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.error) request.reject(new Error(message.error.message ?? "Unknown MCP error"))
  else request.resolve(message.result)
}

function rejectAllPending(pending: Map<string, PendingRequest>, error: Error) {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

export function normalizeMcpServerConfig(server: ResolvedMcpServerConfig): McpServerConfig {
  if ("type" in server) return server
  return {
    type: "stdio",
    command: server.command,
    cwd: server.cwd,
  }
}

export class StdioMcpClient implements McpClient {
  private process: ChildProcessWithoutNullStreams
  private buffer = ""
  private pending = new Map<string, PendingRequest>()

  constructor(command: string[], cwd: string) {
    this.process = spawn(command[0]!, command.slice(1), { cwd, stdio: "pipe" })
    this.process.stdout.on("data", chunk => {
      this.buffer += chunk.toString()
      const lines = this.buffer.split("\n")
      this.buffer = lines.pop() ?? ""
      for (const line of lines.map(item => item.trim()).filter(Boolean)) {
        const message = JSON.parse(line) as JsonRpcResponse
        resolveMessage(message, this.pending)
      }
    })
    this.process.on("exit", () => {
      rejectAllPending(this.pending, new Error("MCP stdio client exited"))
    })
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "monolito-v2", version: "0.2.0" },
    })
    this.notify("notifications/initialized", {})
  }

  listTools() {
    return this.request("tools/list", {})
  }

  callTool(name: string, args: Record<string, unknown>) {
    return this.request("tools/call", { name, arguments: args })
  }

  listResources() {
    return this.request("resources/list", {})
  }

  readResource(uri: string) {
    return this.request("resources/read", { uri })
  }

  close() {
    this.process.kill()
    rejectAllPending(this.pending, new Error("MCP stdio client closed"))
  }

  private notify(method: string, params: unknown) {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  private async request(method: string, params: unknown) {
    const id = randomUUID()
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.process.stdin.write(`${payload}\n`)
    })
  }
}

export class SseMcpClient implements McpClient {
  private readonly streamUrl: string
  private readonly pending = new Map<string, PendingRequest>()
  private readonly streamController = new AbortController()
  private endpointUrl: string | null = null
  private endpointReady: Promise<string>
  private resolveEndpoint!: (value: string) => void
  private rejectEndpoint!: (error: Error) => void
  private streamStarted = false

  constructor(url: string) {
    this.streamUrl = url
    this.endpointReady = new Promise<string>((resolve, reject) => {
      this.resolveEndpoint = resolve
      this.rejectEndpoint = reject
    })
  }

  async initialize() {
    await this.startStream()
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "monolito-v2", version: "0.2.0" },
    })
    await this.notify("notifications/initialized", {})
  }

  listTools() {
    return this.request("tools/list", {})
  }

  callTool(name: string, args: Record<string, unknown>) {
    return this.request("tools/call", { name, arguments: args })
  }

  listResources() {
    return this.request("resources/list", {})
  }

  readResource(uri: string) {
    return this.request("resources/read", { uri })
  }

  close() {
    this.streamController.abort()
    const error = new Error("MCP SSE client closed")
    this.rejectEndpoint(error)
    rejectAllPending(this.pending, error)
  }

  private async startStream() {
    if (this.streamStarted) return
    this.streamStarted = true
    const response = await fetch(this.streamUrl, {
      headers: {
        Accept: "text/event-stream",
      },
      signal: this.streamController.signal,
    })
    if (!response.ok) throw new Error(`Failed to connect to MCP SSE stream: HTTP ${response.status}`)
    if (!response.body) throw new Error("MCP SSE stream has no response body")
    void this.consumeStream(response.body).catch(error => {
      const typed = error instanceof Error ? error : new Error(String(error))
      this.rejectEndpoint(typed)
      rejectAllPending(this.pending, typed)
    })
  }

  private async consumeStream(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      while (true) {
        const nextEvent = takeNextSseEvent(buffer)
        if (!nextEvent) break
        const { rawEvent, rest } = nextEvent
        buffer = rest
        this.handleSseEvent(rawEvent)
      }
    }
    throw new Error("MCP SSE stream ended unexpectedly")
  }

  private handleSseEvent(rawEvent: string) {
    const lines = rawEvent.split(/\r?\n/)
    let eventName = "message"
    const dataLines: string[] = []
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim() || "message"
        continue
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart())
      }
    }
    const data = dataLines.join("\n").trim()
    if (!data) return
    if (eventName === "endpoint") {
      const endpoint = new URL(data, this.streamUrl).toString()
      this.endpointUrl = endpoint
      this.resolveEndpoint(endpoint)
      return
    }
    if (eventName === "message") {
      const message = JSON.parse(data) as JsonRpcResponse
      resolveMessage(message, this.pending)
    }
  }

  private async notify(method: string, params: unknown) {
    await this.postJsonRpc({ jsonrpc: "2.0", method, params })
  }

  private async request(method: string, params: unknown) {
    const id = randomUUID()
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      void this.postJsonRpc({ jsonrpc: "2.0", id, method, params }).catch(error => {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  private async postJsonRpc(payload: Record<string, unknown>) {
    const endpoint = this.endpointUrl ?? await this.endpointReady
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
      signal: this.streamController.signal,
    })
    if (!response.ok) {
      throw new Error(`MCP SSE endpoint rejected request: HTTP ${response.status}`)
    }
  }
}

export function createMcpClient(server: ResolvedMcpServerConfig): McpClient {
  const config = normalizeMcpServerConfig(server)
  if (config.type === "sse") return new SseMcpClient(config.url)
  return new StdioMcpClient(config.command, config.cwd)
}

function takeNextSseEvent(buffer: string) {
  const separators = ["\r\n\r\n", "\n\n"]
  let matchIndex = -1
  let separator = ""
  for (const candidate of separators) {
    const index = buffer.indexOf(candidate)
    if (index === -1) continue
    if (matchIndex === -1 || index < matchIndex) {
      matchIndex = index
      separator = candidate
    }
  }
  if (matchIndex === -1) return null
  return {
    rawEvent: buffer.slice(0, matchIndex),
    rest: buffer.slice(matchIndex + separator.length),
  }
}

export function getDefaultMcpServers(rootDir: string): Record<string, McpServerConfig> {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return {
    demo: {
      type: "stdio",
      command: ["node", "--experimental-strip-types", resolve(moduleDir, "devServer.ts")],
      cwd: rootDir,
    },
  }
}
