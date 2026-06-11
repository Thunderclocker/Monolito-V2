import { mkdirSync, readFileSync, existsSync, statSync, renameSync, unlinkSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { MONOLITO_ROOT } from "../system/root.ts"

/**
 * The single canonical session ID for the user-facing session.
 *
 * Monolito-V2 uses a single-session model for the user: the CLI and
 * Telegram both target this same session. Other sessions in the DB
 * (sub-agents, SkillsAgent, etc.) are internal and live in their
 * own `agent-*` / `skills-synthetic` namespaces — they are not
 * candidates for proactive delivery, the heartbeat, or the TUI's
 * "current session" display.
 *
 * `/new` does NOT create a new session row — it calls `resetSession`
 * on this same session, which clears the messages but keeps the
 * session record and its profile/state. This preserves forensic
 * continuity (the session row keeps its `created_at`, `updated_at`,
 * and any worklog/summary entries) while giving the user a fresh
 * conversation surface.
 */
export const MAIN_SESSION_ID = "orchestrator"

export type AgentEvent =
  | { type: "session.created"; sessionId: string; title: string }
  | { type: "session.resumed"; sessionId: string }
  | { type: "state.changed"; sessionId: string; state: "idle" | "running" | "error" }
  | { type: "message.received"; sessionId: string; role: "user" | "assistant" | "system"; text: string; thinking?: string }
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
  | { type: "permission.request"; sessionId: string; permissionId: string; tool: string; path: string; reason: string }
  | { type: "destructive.confirm"; sessionId: string; confirmId: string; tool: string; command: string; reason: string }
  | {
      type: "todo.updated"
      sessionId: string
      completed: number
      total: number
      items: Array<{ status: "pending" | "in_progress" | "completed"; content: string; activeForm?: string }>
    }
  | {
      type: "ralph.attempt"
      sessionId: string
      attempt: number
      maxAttempts: number
      unfinished: string[]
    }
  | { type: "model.thinking"; sessionId: string; text: string }
  | { type: "model.stream"; sessionId: string; text: string }

export type SessionSummary = {
  id: string
  profileId: string
  title: string
  createdAt: string
  updatedAt: string
  state: "idle" | "running" | "error"
  voiceMode: boolean
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
    thinking?: string
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
  | { id: string; type: "session.ask"; sessionId?: string; prompt: string; stream?: boolean }
  | { id: string; type: "daemon.command"; command: string; args?: string[] }
  | { id: string; type: "session.abort"; sessionId: string }
  | { id: string; type: "session.clear"; sessionId: string }
  | { id: string; type: "permission.respond"; sessionId: string; permissionId: string; decision: "allow" | "deny" | "ask" }

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
  // Resolve the install base at call time, not at module-import time. Tests
  // set `process.env.MONOLITO_ROOT` to a tempdir before calling getDb(); if
  // we read `MONOLITO_ROOT` (the captured constant) instead, the tempdir is
  // ignored and the test writes to the live runtime install. The 09-jun-2026
  // incident: a test run with MONOLITO_ROOT pointing at the live install
  // overwrote CONF_CHANNELS.telegram.token with the placeholder "abc".
  // The env var takes precedence over the captured constant, matching the
  // precedence in `system/root.ts` (pin > env > default).
  const baseDir = process.env.MONOLITO_ROOT || MONOLITO_ROOT
  const runDir = join(baseDir, "run")
  const logsDir = join(baseDir, "logs")
  const agentsDir = join(baseDir, "agents")
  // Workspace del agente: escritorio libre en la raíz de MONOLITO_ROOT.
  // No depende de profileId (single-user); el profileId se mantiene solo
  // para BOOT wings, memoria y sub-agentes.
  const workspaceDir = join(baseDir, "workspace")
  // Scratchpad vive adentro del workspace (es donde el agente trabaja).
  const scratchpadDir = join(workspaceDir, "scratchpad")

  const stateDir = join(baseDir, "memory")
  const socketSuffix = createHash("sha1").update(rootDir).digest("hex").slice(0, 12)
  const socketPath = join("/tmp", `monolitod-v2-${socketSuffix}.sock`)
  const pidFile = join(runDir, "monolitod-v2.pid")
  const daemonLog = join(logsDir, "monolitod.log")
  const lockFile = join(runDir, "daemon-lock.json")
  const ownerFile = join(runDir, "daemon-owner.json")
  const envFile = join(baseDir, ".env")
  const flagPath = join(runDir, "intentional-stop.flag")

  const tcpHost = "127.0.0.1"
  const tcpPort = 7355

  return {
    baseDir,
    stateDir,
    runDir,
    logsDir,
    agentsDir,
    workspaceDir,
    socketPath,
    pidFile,
    daemonLog,
    lockFile,
    ownerFile,
    envFile,
    flagPath,
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
    paths.agentsDir,
    paths.workspaceDir,
    paths.stateDir,
    paths.scratchpadDir,
  ]

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  // Rotate the daemon stderr/stdout log if it has grown too large.
  // The structured logger (createDailyRotatingFileSink) already rotates
  // daily, but the daemon redirects its own stdout/stderr to this file
  // with flag="a" and nothing trims it, so it can grow indefinitely.
  rotateDaemonLogIfLarge(paths.daemonLog, 5 * 1024 * 1024)

  return paths
}

/**
 * If the daemon log is larger than `maxBytes`, rotate it to a single
 * `*.log.old` file (overwriting any previous one) and start fresh.
 * The structured logger writes JSON-per-line so this is a safe point
 * cut (worst case: a half-written final line is dropped).
 */
export function rotateDaemonLogIfLarge(daemonLogPath: string, maxBytes: number) {
  try {
    if (!existsSync(daemonLogPath)) return
    const stat = statSync(daemonLogPath)
    if (stat.size <= maxBytes) return
    const backupPath = `${daemonLogPath}.old`
    try {
      unlinkSync(backupPath)
    } catch {}
    renameSync(daemonLogPath, backupPath)
  } catch {
    // Best-effort rotation — never block startup on a log rotation failure.
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
