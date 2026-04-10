import { mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync, renameSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"

export type AgentEvent =
  | { type: "session.created"; sessionId: string; title: string }
  | { type: "session.resumed"; sessionId: string }
  | { type: "state.changed"; sessionId: string; state: "idle" | "running" | "error" }
  | { type: "message.received"; sessionId: string; role: "user" | "assistant" | "system"; text: string }
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

export type SessionSummary = {
  id: string
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
  const baseDir = join(rootDir, ".monolito-v2")
  const runDir = join(baseDir, "run")
  const logsDir = join(baseDir, "logs")
  const profilesDir = join(baseDir, "profiles")
  const workspaceDir = join(profilesDir, profileId, "workspace")

  const stateDir = join(baseDir, "memory")
  const socketSuffix = createHash("sha1").update(rootDir).digest("hex").slice(0, 12)
  const socketPath = join("/tmp", `monolitod-v2-${socketSuffix}.sock`)
  const pidFile = join(runDir, "monolitod-v2.pid")
  const daemonLog = join(logsDir, "monolitod-v2.log")
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

  // Handle migration of legacy workspace to default profile if needed
  migrateLegacyWorkspace(rootDir, paths.workspaceDir)

  // Finalize initialization
  initWorkspaceTemplate(paths.workspaceDir)
  initDefaultFiles(paths)

  return paths
}

function migrateLegacyWorkspace(rootDir: string, defaultWorkspaceDir: string) {
  const oldWorkspaceDir = join(rootDir, ".monolito-v2", "workspace")
  if (existsSync(oldWorkspaceDir) && !existsSync(join(defaultWorkspaceDir, "SOUL.md"))) {
    // If old workspace exists and new hasn't been initialized, migrate
    mkdirSync(defaultWorkspaceDir, { recursive: true })
    const files = readdirSync(oldWorkspaceDir)
    for (const file of files) {
      const oldPath = join(oldWorkspaceDir, file)
      const newPath = join(defaultWorkspaceDir, file)
      if (existsSync(oldPath)) {
        renameSync(oldPath, newPath)
      }
    }
    // Note: We don't delete oldWorkspaceDir automatically here to be safe, 
    // but the system will now use the new one.
  }
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

function initWorkspaceTemplate(workspaceDir: string) {
  const templates: Record<string, string> = {
    "SOUL.md": "# SOUL.md - Who You Are\n\n- Be genuinely helpful.\n- Be direct and technically rigorous.\n- Prefer solving the problem over explaining why it is hard.\n- Respect private context and avoid external actions unless clearly requested.\n",
    "AGENTS.md": "# AGENTS.md - Workspace Rules\n\n## Session Startup\n1. Read SOUL.md\n2. Read USER.md\n3. Use the injected core files as your bootstrap context\n4. If BOOTSTRAP.md still exists with unresolved instructions, follow it before normal operation and clear it when complete\n\n## Rules\n- Work from evidence.\n- Prefer tools for current local state.\n- Document durable conventions in TOOLS.md or MEMORY.md.\n",
    "USER.md": "# USER.md - User Profile\n\n- Name: Unknown\n- Preferred address: Unknown\n- Pronouns: Optional\n- Timezone: Optional\n- Notes: Fill this in during bootstrap.\n",
    "IDENTITY.md": "# IDENTITY.md - Agent Identity\n\n- Name: Unknown\n- Creature: Unknown\n- Vibe: Unknown\n- Emoji: Optional\n",
    "TOOLS.md": "# TOOLS.md - Tool Conventions\n\n- Use workspace tools for core files.\n- Use memory tools for structured durable memory.\n- Use Bash for current local state outside protected core files.\n",
    "HEARTBEAT.md": "# HEARTBEAT.md - Periodic Tasks\n\nIf a heartbeat poll asks for background checks, keep them short and actionable.\n",
    "MEMORY.md": "# MEMORY.md - Curated Long-Term Memory\n\nKeep distilled, durable notes here. Do not use this for noisy daily logs.\n",
    "BOOTSTRAP.md": "# BOOTSTRAP.md - First Run Ritual\n\nHello. You just came online in a brand new workspace.\n\n## Goal\nStart a short, natural onboarding conversation and learn:\n- Who are you?\n- What should the user call you?\n- What kind of agent are you?\n- What tone or vibe should you have?\n- Who is the user?\n- How should you address them?\n- Any optional notes like timezone, pronouns, or preferences?\n\n## Style\n- Do not interrogate.\n- Ask one short question at a time.\n- Offer 3-5 suggestions when the user is unsure.\n- Keep the exchange warm, concise, and practical.\n\n## Persist what you learn\nOnce details are confirmed, update:\n- IDENTITY.md with your name, creature, vibe, and emoji.\n- USER.md with the user's profile and preferred address.\n- SOUL.md with any durable behavior preferences that came out of onboarding.\n\n## Completion\nWhen onboarding is finished, clear this file or replace it with a one-line completion note such as:\nBootstrap completed.\n",
  }

  for (const [file, content] of Object.entries(templates)) {
    const filePath = join(workspaceDir, file)
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content, "utf8")
    }
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
