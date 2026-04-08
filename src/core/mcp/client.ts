import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

type JsonRpcResponse = {
  id?: string
  result?: unknown
  error?: { message?: string }
}

export class StdioMcpClient {
  private process: ChildProcessWithoutNullStreams
  private buffer = ""
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  constructor(command: string[], cwd: string) {
    this.process = spawn(command[0]!, command.slice(1), { cwd, stdio: "pipe" })
    this.process.stdout.on("data", chunk => {
      this.buffer += chunk.toString()
      const lines = this.buffer.split("\n")
      this.buffer = lines.pop() ?? ""
      for (const line of lines.map(item => item.trim()).filter(Boolean)) {
        const message = JSON.parse(line) as JsonRpcResponse
        if (!message.id) continue
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message ?? "Unknown MCP error"))
        else pending.resolve(message.result)
      }
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

export function getDefaultMcpServers(rootDir: string) {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  return {
    demo: {
      command: ["node", "--experimental-strip-types", resolve(moduleDir, "devServer.ts")],
      cwd: rootDir,
    },
  }
}
