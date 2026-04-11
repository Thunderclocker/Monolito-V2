import { createConnection, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import { type AgentEvent, type Response, decodeLines, encodeEnvelope, readDaemonLock } from "../ipc/protocol.ts"

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type RemoteError = Error & {
  code?: string
}

function isIgnorableSocketError(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : ""
  return code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED"
}

export class DaemonClient {
  private readonly rootDir: string
  private socket: Socket | null = null
  private buffer = ""
  private pending = new Map<string, Pending>()
  private eventListeners = new Set<(event: AgentEvent) => void>()
  private connectionListeners = new Set<(connected: boolean) => void>()
  private connected = false

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  async connect() {
    if (this.socket) return
    const lock = readDaemonLock(this.rootDir)
    if (!lock) throw new Error("monolitod-v2 is not running")

    this.socket = await new Promise<Socket>((resolve, reject) => {
      const socket =
        lock.transport === "unix"
          ? createConnection(lock.socketPath)
          : createConnection(lock.port, lock.host)
      socket.once("error", reject)
      socket.once("connect", () => resolve(socket))
    })
    this.setConnected(true)

    this.socket.on("data", chunk => {
      this.buffer += chunk.toString()
      const decoded = decodeLines(this.buffer)
      this.buffer = decoded.rest
      for (const envelope of decoded.messages) {
        if (envelope.kind === "response") {
          this.handleResponse(envelope.payload)
        } else if (envelope.kind === "event") {
          for (const listener of this.eventListeners) listener(envelope.payload)
        }
      }
    })
    this.socket.on("error", error => {
      if (isIgnorableSocketError(error)) return
      this.setConnected(false)
      for (const [id, pending] of this.pending) {
        this.pending.delete(id)
        pending.reject(new Error(`daemon connection error: ${error.message}`))
      }
    })
    this.socket.on("close", () => {
      this.setConnected(false)
      this.socket = null
    })
  }

  close() {
    this.socket?.end()
    this.socket = null
    this.setConnected(false)
  }

  onEvent(listener: (event: AgentEvent) => void) {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onConnectionChange(listener: (connected: boolean) => void) {
    this.connectionListeners.add(listener)
    listener(this.connected)
    return () => {
      this.connectionListeners.delete(listener)
    }
  }

  isConnected() {
    return this.connected
  }

  async ping() {
    return await this.request("ping", {})
  }

  async ensureSession(sessionId?: string, title?: string) {
    return await this.request("session.ensure", { sessionId, title })
  }

  async startupSession(sessionId: string, prompt: string) {
    return await this.request("session.startup", { sessionId, prompt })
  }

  async listSessions() {
    return await this.request("session.list", {})
  }

  async getSession(sessionId: string) {
    return await this.request("session.get", { sessionId })
  }

  async subscribe(sessionId: string) {
    return await this.request("session.subscribe", { sessionId })
  }

  async abortSession(sessionId: string) {
    return await this.request("session.abort", { sessionId })
  }

  async sendMessage(sessionId: string, text: string) {
    return await this.request("message.send", { sessionId, text })
  }

  async tailEvents(sessionId: string, lines?: number) {
    return await this.request("logs.tail", { sessionId, lines })
  }

  async stopDaemon() {
    await this.connect()
    return await this.request("daemon.stop", {})
  }

  async queryCost() {
    await this.connect()
    return await this.request("query.cost", {})
  }

  async queryStats(sessionId?: string) {
    await this.connect()
    return await this.request("query.stats", { sessionId })
  }

  async queryCompact(sessionId?: string, maxMessages?: number) {
    await this.connect()
    return await this.request("query.compact", { sessionId, maxMessages })
  }

  async queryDoctor() {
    await this.connect()
    return await this.request("query.doctor", {})
  }

  async queryModel() {
    await this.connect()
    return await this.request("query.model", {})
  }

  async queryConfig(action?: string, field?: string, value?: string) {
    await this.connect()
    return await this.request("query.config", { action, field, value })
  }

  private async request(type: ResponseRequestType, payload: Record<string, unknown>) {
    await this.connect()
    const id = randomUUID()
    const request = { id, type, ...payload }
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket!.write(encodeEnvelope({ kind: "request", payload: request as never }))
    })
  }

  private handleResponse(response: Response) {
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    if (response.ok) pending.resolve(response.data)
    else {
      const error = new Error(response.error) as RemoteError
      if (response.error.includes("ya está ocupada")) {
        error.code = "SESSION_BUSY"
      } else {
        error.code = "REMOTE_ERROR"
      }
      pending.reject(error)
    }
  }

  private setConnected(next: boolean) {
    if (this.connected === next) return
    this.connected = next
    for (const listener of this.connectionListeners) listener(next)
  }
}

type ResponseRequestType =
  | "ping"
  | "session.ensure"
  | "session.startup"
  | "session.list"
  | "session.get"
  | "session.subscribe"
  | "message.send"
  | "logs.tail"
  | "daemon.stop"
  | "query.cost"
  | "query.stats"
  | "query.compact"
  | "query.doctor"
  | "query.model"
  | "query.config"
  | "session.abort"
