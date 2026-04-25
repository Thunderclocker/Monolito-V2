import { execFileSync, spawn } from "node:child_process"
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import {
  type DaemonLock,
  type Request,
  type Response,
  decodeLines,
  encodeEnvelope,
  ensureDirs,
  getPaths,
} from "../ipc/protocol.ts"
import { clearUpdateRestartState, MonolitoV2Runtime, readUpdateRestartState } from "./runtime.ts"
import { startChannels, stopChannels } from "../channels/channelManager.ts"
import { addLogSink, createFileSink } from "../logging/logger.ts"
import { warmupEmbeddings } from "../session/embeddings.ts"
import { cleanupScratchpad } from "../system/root.ts"

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
  private ownerFd: number | null = null
  private ownershipMonitor: NodeJS.Timeout | null = null

  constructor(rootDir: string) {
    this.rootDir = rootDir
    this.runtime = new MonolitoV2Runtime(rootDir)
    
    // Conectar el sistema de logger estructurado al archivo de log del daemon
    const paths = getPaths(this.rootDir)
    addLogSink(createFileSink(paths.daemonLog))
  }

  async start() {
    const paths = ensureDirs(this.rootDir)
    this.acquireOwnership(paths)
    cleanupScratchpad()
    if (existsSync(paths.socketPath)) unlinkSync(paths.socketPath)
    writeFileSync(paths.pidFile, String(process.pid))
    const recoveredOnStart = this.runtime.recoverSessions("Recovered after daemon restart")
    if (recoveredOnStart.length > 0) {
      this.writeDaemonLog(`recovered ${recoveredOnStart.length} running session(s) after daemon restart`)
    }

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
    await this.terminateDuplicateDaemons()
    this.startOwnershipMonitor()
    void this.startEmbeddingsWarmup()
    startChannels(this.runtime, { onRestartRequested: () => this.scheduleSelfRestart() })
    return this.server
  }

  stop() {
    this.writeDaemonLog("daemon stop requested")
    stopChannels()
    this.runtime.close()
    this.server?.close()
    const paths = getPaths(this.rootDir)
    const owner = this.readOwnerClaim(paths.ownerFile)
    const ownsSharedState = owner?.pid === process.pid
    if (this.ownershipMonitor) {
      clearInterval(this.ownershipMonitor)
      this.ownershipMonitor = null
    }
    if (ownsSharedState) {
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
    try {
      if (this.ownerFd !== null) {
        closeSync(this.ownerFd)
        this.ownerFd = null
      }
    } catch {}
    try {
      if (owner?.pid === process.pid && existsSync(paths.ownerFile)) unlinkSync(paths.ownerFile)
    } catch {}
  }

  private acquireOwnership(paths: ReturnType<typeof getPaths>) {
    const claim = {
      pid: process.pid,
      claimedAt: new Date().toISOString(),
      rootDir: this.rootDir,
    }

    const tryClaim = () => {
      this.ownerFd = openSync(paths.ownerFile, "wx")
      writeFileSync(paths.ownerFile, `${JSON.stringify(claim, null, 2)}\n`)
    }

    try {
      tryClaim()
      return
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code ?? "")
        : ""
      if (code !== "EEXIST") throw error
    }

    const existing = this.readOwnerClaim(paths.ownerFile)
    if (existing?.pid && this.isProcessRunning(existing.pid)) {
      throw new Error(`monolitod-v2 already running (pid ${existing.pid})`)
    }

    rmSync(paths.ownerFile, { force: true })
    tryClaim()
  }

  private readOwnerClaim(path: string): { pid?: number } | null {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as { pid?: number }
    } catch {
      return null
    }
  }

  private isProcessRunning(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private listDuplicateDaemonPids() {
    try {
      const output = execFileSync("ps", ["-eo", "pid=,args="], {
        encoding: "utf8",
        timeout: 5_000,
      })
      const marker = `${this.rootDir}/src/apps/daemon.ts --foreground`
      return output
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const match = line.match(/^(\d+)\s+(.*)$/)
          if (!match) return null
          return { pid: Number.parseInt(match[1] ?? "", 10), args: match[2] ?? "" }
        })
        .filter((entry): entry is { pid: number; args: string } => Boolean(entry))
        .filter(entry => entry.pid !== process.pid && entry.args.includes(marker))
        .map(entry => entry.pid)
    } catch {
      return []
    }
  }

  private async terminateDuplicateDaemons() {
    const duplicates = this.listDuplicateDaemonPids()
    if (duplicates.length === 0) return

    this.writeDaemonLog(`found duplicate daemons for workspace: ${duplicates.join(", ")}`)
    for (const pid of duplicates) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {}
    }

    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const remaining = duplicates.filter(pid => this.isProcessRunning(pid))
      if (remaining.length === 0) {
        this.writeDaemonLog("duplicate daemons terminated cleanly")
        return
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    const survivors = duplicates.filter(pid => this.isProcessRunning(pid))
    for (const pid of survivors) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    if (survivors.length > 0) {
      this.writeDaemonLog(`duplicate daemons required SIGKILL: ${survivors.join(", ")}`)
    }
  }

  private startOwnershipMonitor() {
    if (this.ownershipMonitor) return
    this.ownershipMonitor = setInterval(() => {
      const owner = this.readOwnerClaim(getPaths(this.rootDir).ownerFile)
      if (owner?.pid === process.pid) return
      this.writeDaemonLog(`ownership lost; shutting down pid ${process.pid}`)
      this.stop()
      setTimeout(() => process.exit(0), 50)
    }, 5_000)
    this.ownershipMonitor.unref()
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
        const restartState = readUpdateRestartState(this.rootDir)
        const restartStatePath = `${paths.runDir}/update-restart.json`
        const restartScript = [
          "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done",
          "\"$2\" --experimental-strip-types \"$3\" --foreground &",
          "child=$!",
          "sleep 2",
          "if kill -0 \"$child\" 2>/dev/null; then rm -f \"$7\"; exit 0; fi",
          "if [ -n \"$4\" ]; then git -C \"$5\" reset --hard \"$4\" || exit 1; fi",
          "if [ -n \"$4\" ]; then git -C \"$5\" clean -fd || exit 1; fi",
          "if [ -n \"$6\" ]; then stash_ref=$(git -C \"$5\" stash list --format='%gd\t%s' | awk -F '\t' -v label=\"$6\" '$2==label { print $1; exit }'); if [ -n \"$stash_ref\" ]; then git -C \"$5\" stash apply --index \"$stash_ref\" || exit 1; git -C \"$5\" stash drop \"$stash_ref\" || exit 1; fi; fi",
          "rm -f \"$7\"",
          "exec \"$2\" --experimental-strip-types \"$3\" --foreground",
        ].join("\n")
        const child = spawn("sh", [
          "-lc",
          restartScript,
          "monolito-restart",
          String(process.pid),
          process.execPath,
          daemonPath,
          restartState?.currentHead ?? "",
          this.rootDir,
          restartState?.stashLabel ?? "",
          restartStatePath,
        ], {
          cwd: this.rootDir,
          detached: true,
          stdio: ["ignore", stdout, stderr],
        })
        child.unref()
        this.writeDaemonLog(`daemon self-restart spawned child pid ${child.pid ?? "unknown"}`)
        this.stop()
      } catch (error) {
        clearUpdateRestartState(this.rootDir)
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

  private async startEmbeddingsWarmup() {
    this.writeDaemonLog("embeddings warmup started")
    const timeoutMs = 30_000
    const timeout = new Promise<{ ok: false; timeout: true }>(resolve => {
      setTimeout(() => resolve({ ok: false, timeout: true }), timeoutMs).unref()
    })
    try {
      const result = await Promise.race([warmupEmbeddings(this.rootDir), timeout])
      if ("timeout" in result) {
        this.writeDaemonLog(`embeddings warmup timed out after ${timeoutMs}ms; continuing in lazy mode`)
        return
      }
      if ("error" in result) {
        this.writeDaemonLog(`embeddings warmup failed; continuing in lazy mode: ${result.error}`)
      } else {
        this.writeDaemonLog(`embeddings warmup ready model=${result.model} cacheDir=${result.cacheDir ?? "(default)"}`)
      }
    } catch (error) {
      this.writeDaemonLog(`embeddings warmup failed; continuing in lazy mode: ${error instanceof Error ? error.message : String(error)}`)
    }
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
        const response: Response = await this.handleRequest(socket, envelope.payload)
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

  private async handleRequest(socket: Socket, request: Request): Promise<Response> {
    try {
      switch (request.type) {
        case "ping":
          return { id: request.id, ok: true as const, data: { pid: process.pid } }
        case "session.ensure":
          return { id: request.id, ok: true as const, data: this.runtime.ensureSession(request.sessionId, request.title) }
        case "session.startup":
          await this.runtime.processSessionStartup(request.sessionId, request.prompt)
          if (this.runtime.consumeRestartRequest()) {
            this.scheduleSelfRestart()
          }
          return { id: request.id, ok: true as const, data: { accepted: true } }
        case "session.list":
          return { id: request.id, ok: true as const, data: this.runtime.listSessions() }
        case "session.get":
          return { id: request.id, ok: true as const, data: this.runtime.getSession(request.sessionId) }
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
          return { id: request.id, ok: true as const, data: { subscribed: sid } }
        }
        case "logs.tail":
          return { id: request.id, ok: true as const, data: this.runtime.tailEvents(request.sessionId, request.lines) }
        case "message.send":
          await this.runtime.processMessage(request.sessionId, request.text)
          if (this.runtime.consumeRestartRequest()) {
            this.scheduleSelfRestart()
          }
          return { id: request.id, ok: true as const, data: { accepted: true } }
        case "session.abort":
          this.runtime.abortSession(request.sessionId)
          return { id: request.id, ok: true as const, data: { aborted: true } }
        case "daemon.stop": {
          this.stop()
          const response = { id: request.id, ok: true as const, data: { stopped: true } }
          this.safeWrite(socket, encodeEnvelope({ kind: "response", payload: response }))
          setTimeout(() => process.exit(0), 200)
          return response
        }
        case "query.cost":
          return { id: request.id, ok: true as const, data: this.runtime.queryCost() }
        case "query.stats": {
          const sid = (request as { sessionId?: string }).sessionId ?? ""
          return { id: request.id, ok: true as const, data: this.runtime.queryStats(sid) }
        }
        case "query.compact": {
          const sid = (request as { sessionId?: string }).sessionId ?? ""
          const max = (request as { maxMessages?: number }).maxMessages
          return { id: request.id, ok: true as const, data: this.runtime.queryCompact(sid, max) }
        }
        case "query.doctor":
          return { id: request.id, ok: true as const, data: this.runtime.queryDoctor() }
        case "query.model":
          return { id: request.id, ok: true as const, data: this.runtime.queryModelInfo() }
        case "query.config": {
          const req = request as Record<string, string | undefined>
          const data = await this.runtime.queryConfig(req.action, req.field, req.value)
          return { id: request.id, ok: true as const, data }
        }
      }
    } catch (error) {
      return { id: request.id, ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
