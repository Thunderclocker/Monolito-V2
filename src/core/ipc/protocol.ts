import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { MONOLITO_ROOT } from "../system/root.ts"

export type AgentEvent =
  | { type: "session.created"; sessionId: string; title: string }
  | { type: "session.resumed"; sessionId: string }
  | { type: "state.changed"; sessionId: string; state: "idle" | "running" | "error" }
  | { type: "message.received"; sessionId: string; role: "user" | "assistant" | "system"; text: string }
  | { type: "message.queued"; sessionId: string; role: "user"; text: string }
  | {
      type: "turn.completed"
      sessionId: string
      role: "assistant"
      durationMs: number
      usage?: {
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
      }
    }
  | { type: "tool.start"; sessionId: string; toolUseId?: string; tool: string; input: unknown }
  | { type: "tool.finish"; sessionId: string; toolUseId?: string; tool: string; ok: boolean; output: unknown }
  | { type: "error"; sessionId: string; error: string }
  | { type: "mcp.connected"; sessionId: string; server: string }
  | { type: "mcp.called"; sessionId: string; server: string; tool: string }
  | { type: "agent.background.completed"; sessionId: string; agentId: string; status: "completed" | "failed" | "killed"; result?: string; error?: string }

export type SessionSummary = {
  id: string
  profileId: string
  title: string
  createdAt: string
  updatedAt: string
  state: "idle" | "running" | "error"
}

export type SessionWorklogEntry = {
  at: string
  type: "session" | "message" | "tool" | "note"
  summary: string
}

export type SessionRecord = SessionSummary & {
  messages: Array<{
    at: string
    role: "user" | "assistant" | "system"
    text: string
  }>
  worklog: SessionWorklogEntry[]
}

export type Request =
  | { id: string; type: "ping" }
  | { id: string; type: "session.ensure"; sessionId?: string; title?: string }
  | { id: string; type: "session.startup"; sessionId: string; prompt: string }
  | { id: string; type: "session.list" }
  | { id: string; type: "session.get"; sessionId: string }
  | { id: string; type: "session.subscribe"; sessionId: string }
  | { id: string; type: "message.send"; sessionId: string; text: string }
  | { id: string; type: "logs.tail"; sessionId: string; lines?: number }
  | { id: string; type: "daemon.stop" }
  | { id: string; type: "query.cost" }
  | { id: string; type: "query.stats"; sessionId?: string }
  | { id: string; type: "query.compact"; sessionId?: string; maxMessages?: number }
  | { id: string; type: "query.doctor" }
  | { id: string; type: "query.model" }
  | { id: string; type: "query.config"; action?: string; field?: string; value?: string }
  | { id: string; type: "session.abort"; sessionId: string }

export type Response =
  | { id: string; ok: true; data?: unknown }
  | { id: string; ok: false; error: string }

export type Envelope =
  | { kind: "request"; payload: Request }
  | { kind: "response"; payload: Response }
  | { kind: "event"; payload: AgentEvent }

export type DaemonLock =
  | {
      pid: number
      startedAt: string
      transport: "unix"
      socketPath: string
    }
  | {
      pid: number
      startedAt: string
      transport: "tcp"
      host: string
      port: number
    }

export function encodeEnvelope(envelope: Envelope) {
  return `${JSON.stringify(envelope)}\n`
}

export function decodeLines(buffer: string): { messages: Envelope[]; rest: string } {
  const lines = buffer.split("\n")
  const rest = lines.pop() ?? ""
  const messages = lines
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as Envelope)
  return { messages, rest }
}

export function getPaths(rootDir: string, profileId: string = "default") {
  const baseDir = MONOLITO_ROOT
  const runDir = join(baseDir, "run")
  const logsDir = join(baseDir, "logs")
  const profilesDir = join(baseDir, "profiles")
  const workspaceDir = join(profilesDir, profileId, "workspace")

  const stateDir = join(baseDir, "memory")
  const socketSuffix = createHash("sha1").update(rootDir).digest("hex").slice(0, 12)
  const socketPath = join("/tmp", `monolitod-v2-${socketSuffix}.sock`)
  const pidFile = join(runDir, "monolitod-v2.pid")
  const daemonLog = join(logsDir, "monolitod.log")
  const lockFile = join(runDir, "daemon-lock.json")
  const ownerFile = join(runDir, "daemon-owner.json")
  const envFile = join(baseDir, ".env")
  const scratchpadDir = join(baseDir, "scratchpad")

  const tcpHost = "127.0.0.1"
  const tcpPort = 7355

  return {
    baseDir,
    stateDir,
    runDir,
    logsDir,
    profilesDir,
    workspaceDir,
    socketPath,
    pidFile,
    daemonLog,
    lockFile,
    ownerFile,
    envFile,
    scratchpadDir,
    profileId,
    tcpHost,
    tcpPort,
  }
}

export function ensureParentDir(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true })
}

export function ensureDirs(rootDir: string, profileId: string = "default") {
  const paths = getPaths(rootDir, profileId)
  const dirs = [
    paths.baseDir,
    paths.runDir,
    paths.logsDir,
    paths.profilesDir,
    paths.workspaceDir,
    paths.stateDir,
    paths.scratchpadDir,
  ]

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  initDefaultFiles(paths)

  return paths
}

function initDefaultFiles(paths: ReturnType<typeof getPaths>) {
  if (!existsSync(paths.envFile)) {
    writeFileSync(paths.envFile, "# Monolito V2 Environment Secrets\n", "utf8")
  }
  const permissionsFile = join(paths.baseDir, "permissions.json")
  if (!existsSync(permissionsFile)) {
    writeFileSync(permissionsFile, `${JSON.stringify({
      mode: "acceptEdits",
      rules: [
        { tool: "Bash", action: "allow", input: "git status*" },
        { tool: "Bash", action: "allow", input: "npm test*" },
      ],
    }, null, 2)}\n`, "utf8")
  }
  const hooksFile = join(paths.baseDir, "hooks.json")
  if (!existsSync(hooksFile)) {
    writeFileSync(hooksFile, `${JSON.stringify({
      PreToolUse: [],
      PostToolUse: [],
    }, null, 2)}\n`, "utf8")
  }
}

export function readDaemonLock(rootDir: string): DaemonLock | null {
  const path = getPaths(rootDir).lockFile
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DaemonLock
  } catch {
    return null
  }
}
