import { spawn } from "node:child_process"
import { appendFileSync, existsSync, openSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import {
  type DaemonLock,
  type Request,
  decodeLines,
  encodeEnvelope,
  ensureDirs,
  getPaths,
} from "../ipc/protocol.ts"
import { MonolitoV2Runtime } from "./runtime.ts"
import { startChannels, stopChannels } from "../channels/channelManager.ts"
import { addLogSink, createFileSink } from "../logging/logger.ts"

function isIgnorableSocketError(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : ""
  return code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED"
}

export class MonolitoV2Daemon {
  private subscribers = new Map<string, Set<Socket>>()
  private socketSubscriptions = new Map<Socket, Map<string, () => void>>()
  readonly rootDir: string
  readonly runtime: MonolitoV2Runtime
  private server: Server | null = null
  private restartInFlight = false

  constructor(rootDir: string) {
    this.rootDir = rootDir
    this.runtime = new MonolitoV2Runtime(rootDir)
    
    // Conectar el sistema de logger estructurado al archivo de log del daemon
    const paths = getPaths(this.rootDir)
    addLogSink(createFileSink(paths.daemonLog))
  }

  async start() {
    const paths = ensureDirs(this.rootDir)
    if (existsSync(paths.socketPath)) unlinkSync(paths.socketPath)
    writeFileSync(paths.pidFile, String(process.pid))
    this.runtime.recoverSessions("Recovered after daemon restart")

    try {
      this.server = await this.listenUnix(paths.socketPath)
      this.writeLock({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        transport: "unix",
        socketPath: paths.socketPath,
      })
      this.writeDaemonLog(`monolitod-v2 listening on unix socket ${paths.socketPath}`)
    } catch {
      this.server = await this.listenTcp(paths.tcpHost, paths.tcpPort)
      this.writeLock({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        transport: "tcp",
        host: paths.tcpHost,
        port: paths.tcpPort,
      })
      this.writeDaemonLog(`monolitod-v2 listening on tcp ${paths.tcpHost}:${paths.tcpPort}`)
    }
    startChannels(this.runtime, { onRestartRequested: () => this.scheduleSelfRestart() })
    return this.server
  }

  stop() {
    this.runtime.close()
    this.server?.close()
    stopChannels()
    const paths = getPaths(this.rootDir)
    try {
      if (existsSync(paths.socketPath)) unlinkSync(paths.socketPath)
    } catch {}
    try {
      if (existsSync(paths.lockFile)) unlinkSync(paths.lockFile)
    } catch {}
    try {
      if (existsSync(paths.pidFile)) unlinkSync(paths.pidFile)
    } catch {}
  }

  private scheduleSelfRestart() {
    if (this.restartInFlight) return
    this.restartInFlight = true
    stopChannels()
    this.writeDaemonLog("telegram channels stopped for self-restart")

    setTimeout(() => {
      try {
        const paths = getPaths(this.rootDir)
        const stdout = openSync(paths.daemonLog, "a")
        const stderr = openSync(paths.daemonLog, "a")
        const daemonPath = `${this.rootDir}/src/apps/daemon.ts`
        const restartScript = [
          "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done",
          "exec \"$2\" --experimental-strip-types \"$3\" --foreground",
        ].join("; ")
        const child = spawn("sh", ["-lc", restartScript, "monolito-restart", String(process.pid), process.execPath, daemonPath], {
          cwd: this.rootDir,
          detached: true,
          stdio: ["ignore", stdout, stderr],
        })
        child.unref()
        this.stop()
      } catch (error) {
        this.writeDaemonLog(`daemon self-restart failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        process.exit(0)
      }
    }, 200)
  }

  private listenUnix(socketPath: string) {
    return new Promise<Server>((resolve, reject) => {
      const server = createServer(socket => this.handleConnection(socket))
      server.once("error", reject)
      server.listen(socketPath, () => resolve(server))
    })
  }

  private listenTcp(host: string, port: number) {
    return new Promise<Server>((resolve, reject) => {
      const server = createServer(socket => this.handleConnection(socket))
      server.once("error", reject)
      server.listen(port, host, () => resolve(server))
    })
  }

  private writeLock(lock: DaemonLock) {
    const { lockFile } = getPaths(this.rootDir)
    writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
  }

  private writeDaemonLog(line: string) {
    appendFileSync(getPaths(this.rootDir).daemonLog, `${new Date().toISOString()} ${line}\n`)
  }

  private safeWrite(socket: Socket, payload: string) {
    if (socket.destroyed || !socket.writable) return false
    try {
      socket.write(payload)
      return true
    } catch (error) {
      if (!isIgnorableSocketError(error)) {
        this.writeDaemonLog(`socket write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return false
    }
  }

  private handleConnection(socket: Socket) {
    let buffer = ""
    socket.on("error", error => {
      if (!isIgnorableSocketError(error)) {
        this.writeDaemonLog(`client socket error: ${error.message}`)
      }
    })
    socket.on("data", async chunk => {
      buffer += chunk.toString()
      const decoded = decodeLines(buffer)
      buffer = decoded.rest
      for (const envelope of decoded.messages) {
        if (envelope.kind !== "request") continue
        const response = await this.handleRequest(socket, envelope.payload)
        this.safeWrite(socket, encodeEnvelope({ kind: "response", payload: response }))
      }
    })
    socket.on("close", () => {
      for (const [, sockets] of this.subscribers) sockets.delete(socket)
      const unsubscribers = this.socketSubscriptions.get(socket)
      if (unsubscribers) {
        for (const unsubscribe of unsubscribers.values()) {
          try {
            unsubscribe()
          } catch {}
        }
        this.socketSubscriptions.delete(socket)
      }
    })
  }

  private async handleRequest(socket: Socket, request: Request) {
    try {
      switch (request.type) {
        case "ping":
          return { id: request.id, ok: true, data: { pid: process.pid } }
        case "session.ensure":
          return { id: request.id, ok: true, data: this.runtime.ensureSession(request.sessionId, request.title) }
        case "session.list":
          return { id: request.id, ok: true, data: this.runtime.listSessions() }
        case "session.get":
          return { id: request.id, ok: true, data: this.runtime.getSession(request.sessionId) }
        case "session.subscribe": {
          const sid = request.sessionId
          const list = this.subscribers.get(sid) ?? new Set<Socket>()
          list.add(socket)
          this.subscribers.set(sid, list)

          const socketSubs = this.socketSubscriptions.get(socket) ?? new Map<string, () => void>()
          if (!socketSubs.has(sid)) {
            const unsubscribe = this.runtime.onEvent(event => {
              // Broadcast to specific session or global subscribers
              if (event.sessionId === sid || sid === "*") {
                this.safeWrite(socket, encodeEnvelope({ kind: "event", payload: event }))
              }
            })
            socketSubs.set(sid, unsubscribe)
            this.socketSubscriptions.set(socket, socketSubs)
          }
          return { id: request.id, ok: true, data: { subscribed: sid } }
        }
        case "logs.tail":
          return { id: request.id, ok: true, data: this.runtime.tailEvents(request.sessionId, request.lines) }
        case "message.send":
          await this.runtime.processMessage(request.sessionId, request.text)
          if (this.runtime.consumeRestartRequest()) {
            this.scheduleSelfRestart()
          }
          return { id: request.id, ok: true, data: { accepted: true } }
        case "session.abort":
          this.runtime.abortSession(request.sessionId)
          return { id: request.id, ok: true, data: { aborted: true } }
        case "daemon.stop": {
          this.stop()
          const response = { id: request.id, ok: true as const, data: { stopped: true } }
          this.safeWrite(socket, encodeEnvelope({ kind: "response", payload: response }))
          setTimeout(() => process.exit(0), 200)
          return response
        }
        case "query.cost":
          return { id: request.id, ok: true, data: this.runtime.queryCost() }
        case "query.stats": {
          const sid = (request as { sessionId?: string }).sessionId ?? ""
          return { id: request.id, ok: true, data: this.runtime.queryStats(sid) }
        }
        case "query.compact": {
          const sid = (request as { sessionId?: string }).sessionId ?? ""
          const max = (request as { maxMessages?: number }).maxMessages
          return { id: request.id, ok: true, data: this.runtime.queryCompact(sid, max) }
        }
        case "query.doctor":
          return { id: request.id, ok: true, data: this.runtime.queryDoctor() }
        case "query.model":
          return { id: request.id, ok: true, data: this.runtime.queryModelInfo() }
        case "query.config": {
          const req = request as Record<string, string | undefined>
          const data = await this.runtime.queryConfig(req.action, req.field, req.value)
          return { id: request.id, ok: true, data }
        }
      }
    } catch (error) {
      return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
