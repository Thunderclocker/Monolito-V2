import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { extname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

type JsonRpcId = string | number

type JsonRpcMessage = {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

function toRequestKey(id: JsonRpcId) {
  return String(id)
}

function inferLanguageId(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case ".tsx":
      return "typescriptreact"
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript"
    case ".jsx":
      return "javascriptreact"
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript"
    case ".json":
      return "json"
    default:
      return "plaintext"
  }
}

export class StdioLspClient {
  private process: ChildProcessWithoutNullStreams
  private buffer = Buffer.alloc(0)
  private pending = new Map<string, PendingRequest>()
  private openedDocuments = new Set<string>()
  private initialized = false
  private readonly cwd: string
  private readonly requestTimeoutMs: number

  constructor(cwd: string, requestTimeoutMs = 15_000) {
    this.cwd = cwd
    this.requestTimeoutMs = requestTimeoutMs
    this.process = spawn("npx", ["typescript-language-server", "--stdio"], {
      cwd,
      stdio: "pipe",
    })

    this.process.stdout.on("data", chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      this.buffer = Buffer.concat([this.buffer, buffer])
      this.consumeMessages()
    })

    this.process.on("error", error => {
      this.failPending(new Error(`Failed to start typescript-language-server: ${error.message}`))
    })

    this.process.on("exit", (code, signal) => {
      this.failPending(new Error(`typescript-language-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`))
    })
  }

  async initialize(rootUri: string) {
    if (this.initialized) return
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {},
      clientInfo: { name: "monolito-v2", version: "0.2.0" },
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
    })
    this.notify("initialized", {})
    this.initialized = true
  }

  async getDefinition(file: string, line: number, character: number) {
    const uri = await this.prepareDocument(file)
    return await this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    })
  }

  async getReferences(file: string, line: number, character: number) {
    const uri = await this.prepareDocument(file)
    return await this.request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    })
  }

  async getHover(file: string, line: number, character: number) {
    const uri = await this.prepareDocument(file)
    return await this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    })
  }

  close() {
    this.failPending(new Error("LSP client closed"))
    this.process.kill()
  }

  private async prepareDocument(file: string) {
    const absolute = resolve(this.cwd, file)
    const uri = pathToFileURL(absolute).href
    if (!this.openedDocuments.has(uri)) {
      const text = readFileSync(absolute, "utf8")
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: inferLanguageId(absolute),
          version: 1,
          text,
        },
      })
      this.openedDocuments.add(uri)
    }
    return uri
  }

  private notify(method: string, params: unknown) {
    this.writeMessage({ jsonrpc: "2.0", method, params })
  }

  private async request(method: string, params: unknown) {
    const id = randomUUID()
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP request timed out for ${method} after ${this.requestTimeoutMs}ms`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.writeMessage({ jsonrpc: "2.0", id, method, params })
    })
  }

  private writeMessage(message: JsonRpcMessage) {
    const payload = Buffer.from(JSON.stringify(message), "utf8")
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8")
    this.process.stdin.write(Buffer.concat([header, payload]))
  }

  private consumeMessages() {
    while (true) {
      const separator = this.buffer.indexOf("\r\n\r\n")
      if (separator === -1) return
      const header = this.buffer.subarray(0, separator).toString("utf8")
      const match = header.match(/Content-Length:\s*(\d+)/i)
      if (!match) {
        this.buffer = this.buffer.subarray(separator + 4)
        continue
      }
      const contentLength = Number(match[1])
      const messageStart = separator + 4
      const messageEnd = messageStart + contentLength
      if (this.buffer.length < messageEnd) return
      const body = this.buffer.subarray(messageStart, messageEnd).toString("utf8")
      this.buffer = this.buffer.subarray(messageEnd)
      const message = JSON.parse(body) as JsonRpcMessage
      this.handleMessage(message)
    }
  }

  private handleMessage(message: JsonRpcMessage) {
    if (message.id === undefined) return
    const key = toRequestKey(message.id)
    const pending = this.pending.get(key)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(key)
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "Unknown LSP error"))
      return
    }
    pending.resolve(message.result)
  }

  private failPending(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

const sharedClients = new Map<string, Promise<StdioLspClient>>()

export function getSharedLspClient(rootDir: string) {
  const resolvedRoot = resolve(rootDir)
  let existing = sharedClients.get(resolvedRoot)
  if (existing) return existing
  existing = (async () => {
    const client = new StdioLspClient(resolvedRoot)
    await client.initialize(pathToFileURL(resolvedRoot).href)
    return client
  })().catch(error => {
    sharedClients.delete(resolvedRoot)
    throw error
  })
  sharedClients.set(resolvedRoot, existing)
  return existing
}
