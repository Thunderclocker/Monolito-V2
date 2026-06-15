import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { ensureDirs } from "../ipc/protocol.ts"
import type { AgentEvent, SessionRecord, SessionSummary, SessionWorklogEntry } from "../ipc/protocol.ts"
import {
  CONFIG_WING_ORDER,
  DEFAULT_CONFIG_WING_VALUES,
  type ConfigWingName,
  type ConfigWingValueMap,
} from "../config/configWings.ts"
import {
  actionLogPath,
  configDir,
  configWingPath,
  graphPath,
  memoryAgentCursorPath,
  profilesPath,
  ralphRulesPath,
  resolvedErrorsPath,
  semanticToolsPath,
  sessionDir,
  sessionEventsPath,
  sessionMessagesPath,
  sessionMetaPath,
  sessionPrefsPath,
  sessionSourcesPath,
  sessionTasksPath,
  sessionWorklogPath,
  sessionsDir,
  stateDir,
  telegramDir,
  telegramSentPhotosPath,
  telegramUpdatesPath,
  modelConfigPath,
} from "./filePaths.ts"
import { memoryMdPath } from "./memoryPaths.ts"

type FileSessionTask = {
  id: string
  content: string
  activeForm?: string
  status: "pending" | "in_progress" | "completed"
  createdAt: string
  updatedAt?: string
  sessionId?: string
  category?: "cognitive" | "life"
}

type FileKnowledgeGraphTriple = {
  id: string
  profile_id: string | null
  subject: string
  predicate: string
  object: string
  valid_from: string
  valid_to: string | null
  created_at: string
  is_active: boolean
}

// --- low-level helpers ---

function ensureParent(path: string) {
  mkdirSync(dirname(path), { recursive: true })
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(path: string, value: unknown) {
  ensureParent(path)
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8")
  renameSync(tmp, path)
}

function appendJsonl(path: string, row: unknown) {
  ensureParent(path)
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8")
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
  const out: T[] = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T)
    } catch { /* skip corrupt line */ }
  }
  return out
}

function writeJsonlAtomic(path: string, rows: unknown[]) {
  ensureParent(path)
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8")
  renameSync(tmp, path)
}

export type FileMessageRow = {
  id: number
  role: string
  text: string
  thinking?: string | null
  at: string
  is_compacted?: number
  hidden_from_user?: number
  hidden_from_model?: number
}

export type FileSessionMeta = {
  id: string
  profile_id: string
  title: string
  state: string
  created_at: string
  updated_at: string
  voice_mode: boolean
  next_message_id: number
}

export type FileWorklogRow = SessionWorklogEntry

export type FileTelegramUpdate = {
  update_id: number
  chat_id: number | null
  received_at: string
  processed_at: string | null
  raw_json: string
}

export type FileTelegramSentPhoto = {
  id: number
  chat_id: number
  message_id: number
  file_id: string | null
  local_path: string
  caption: string | null
  sent_at: string
}

const instances = new Map<string, FileStorageBackend>()

export function getFileStorage(rootDir: string): FileStorageBackend {
  let inst = instances.get(rootDir)
  if (!inst) {
    inst = new FileStorageBackend(rootDir)
    instances.set(rootDir, inst)
  }
  return inst
}

export class FileStorageBackend {
  readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = rootDir
    ensureDirs(rootDir)
    mkdirSync(configDir(rootDir), { recursive: true })
    mkdirSync(sessionsDir(rootDir), { recursive: true })
    mkdirSync(stateDir(rootDir), { recursive: true })
    mkdirSync(telegramDir(rootDir), { recursive: true })
  }

  ensureKernelSeeded() {
    this.ensureProfiles()
    for (const wing of CONFIG_WING_ORDER) {
      const path = configWingPath(this.rootDir, wing)
      if (!existsSync(path)) {
        writeJsonAtomic(path, DEFAULT_CONFIG_WING_VALUES[wing])
      }
    }
  }

  ensureProfiles() {
    const path = profilesPath(this.rootDir)
    const profiles = readJsonFile<Array<{ id: string; name: string; description: string | null; created_at: string }>>(path, [])
    if (!profiles.some(p => p.id === "default")) {
      profiles.push({
        id: "default",
        name: "Default Agent",
        description: "El agente Monolito principal por defecto.",
        created_at: new Date().toISOString(),
      })
      writeJsonAtomic(path, profiles)
    }
  }

  readConfigWing<T extends ConfigWingName>(wing: T): ConfigWingValueMap[T] {
    this.ensureKernelSeeded()
    const path = configWingPath(this.rootDir, wing)
    if (!existsSync(path)) throw new Error(`CONFIG wing ${wing} not found at ${path}`)
    return readJsonFile(path, DEFAULT_CONFIG_WING_VALUES[wing]) as ConfigWingValueMap[T]
  }

  writeConfigWing<T extends ConfigWingName>(wing: T, value: ConfigWingValueMap[T]): { changed: boolean; bytes: number } {
    this.ensureKernelSeeded()
    const path = configWingPath(this.rootDir, wing)
    const content = JSON.stringify(value, null, 2)
    const current = existsSync(path) ? readFileSync(path, "utf8") : null
    if (current === content) return { changed: false, bytes: Buffer.byteLength(content) }
    writeJsonAtomic(path, value)
    return { changed: true, bytes: Buffer.byteLength(content) }
  }

  listProfiles() {
    this.ensureProfiles()
    return readJsonFile<Array<{ id: string; name: string; description: string | null; created_at: string }>>(
      profilesPath(this.rootDir),
      [],
    )
  }

  createProfile(id: string, name: string, description?: string) {
    this.ensureProfiles()
    const path = profilesPath(this.rootDir)
    const profiles = this.listProfiles()
    if (profiles.some(p => p.id === id)) return id
    profiles.push({ id, name, description: description ?? null, created_at: new Date().toISOString() })
    writeJsonAtomic(path, profiles)
    return id
  }

  private readSessionMeta(sessionId: string): FileSessionMeta | null {
    return readJsonFile<FileSessionMeta | null>(sessionMetaPath(this.rootDir, sessionId), null)
  }

  private writeSessionMeta(meta: FileSessionMeta) {
    writeJsonAtomic(sessionMetaPath(this.rootDir, meta.id), meta)
  }

  private ensureSessionDir(sessionId: string) {
    mkdirSync(sessionDir(this.rootDir, sessionId), { recursive: true })
  }

  createSession(title: string, sessionId?: string, profileId = "default"): SessionRecord {
    const now = new Date().toISOString()
    const id = sessionId ?? randomUUID()
    this.ensureSessionDir(id)
    const meta: FileSessionMeta = {
      id,
      profile_id: profileId,
      title,
      state: "idle",
      created_at: now,
      updated_at: now,
      voice_mode: false,
      next_message_id: 1,
    }
    this.writeSessionMeta(meta)
    this.appendWorklog(id, { type: "session", summary: `Session created: ${title.slice(0, 120)}` })
    return this.getSession(id)!
  }

  getSession(sessionId: string): SessionRecord | null {
    const meta = this.readSessionMeta(sessionId)
    if (!meta) return null
    const messages = this.readMessages(sessionId)
      .filter(m => !m.hidden_from_user)
      .map(m => ({
        at: m.at,
        role: m.role as "user" | "assistant" | "system",
        text: m.text,
        thinking: m.thinking ?? undefined,
        hiddenFromModel: m.hidden_from_model === 1,
      }))
    const worklog = readJsonl<FileWorklogRow>(sessionWorklogPath(this.rootDir, sessionId))
    return {
      id: meta.id,
      profileId: meta.profile_id ?? "default",
      title: meta.title ?? "",
      createdAt: meta.created_at,
      updatedAt: meta.updated_at,
      state: (meta.state ?? "idle") as SessionRecord["state"],
      voiceMode: meta.voice_mode === true,
      messages,
      worklog,
    }
  }

  updateSessionProfile(sessionId: string, profileId: string) {
    const meta = this.readSessionMeta(sessionId)
    if (!meta) return
    meta.profile_id = profileId
    meta.updated_at = new Date().toISOString()
    this.writeSessionMeta(meta)
  }

  saveSession(session: SessionRecord) {
    const meta = this.readSessionMeta(session.id)
    if (!meta) return
    meta.title = session.title
    meta.state = session.state
    meta.voice_mode = session.voiceMode === true
    meta.updated_at = new Date().toISOString()
    this.writeSessionMeta(meta)
  }

  listSessions(profileId?: string): SessionSummary[] {
    if (!existsSync(sessionsDir(this.rootDir))) return []
    const ids = readdirSync(sessionsDir(this.rootDir), { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
    const summaries: SessionSummary[] = []
    for (const id of ids) {
      const meta = this.readSessionMeta(id)
      if (!meta) continue
      if (profileId && meta.profile_id !== profileId) continue
      summaries.push({
        id: meta.id,
        profileId: meta.profile_id ?? "default",
        title: meta.title ?? "",
        state: (meta.state ?? "idle") as SessionSummary["state"],
        voiceMode: meta.voice_mode === true,
        createdAt: meta.created_at,
        updatedAt: meta.updated_at,
      })
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return summaries
  }

  readMessages(sessionId: string): FileMessageRow[] {
    return readJsonl<FileMessageRow>(sessionMessagesPath(this.rootDir, sessionId))
  }

  appendMessage(
    sessionId: string,
    role: "user" | "assistant" | "system",
    text: string,
    options: { hiddenFromUser?: boolean; hiddenFromModel?: boolean; thinking?: string } = {},
  ): number {
    const meta = this.readSessionMeta(sessionId)
    if (!meta) throw new Error(`Session not found: ${sessionId}`)
    const now = new Date().toISOString()
    const id = meta.next_message_id
    meta.next_message_id += 1
    meta.updated_at = now
    this.writeSessionMeta(meta)
    const row: FileMessageRow = {
      id,
      role,
      text,
      thinking: options.thinking ?? null,
      at: now,
      is_compacted: 0,
      hidden_from_user: options.hiddenFromUser ? 1 : 0,
      hidden_from_model: options.hiddenFromModel ? 1 : 0,
    }
    appendJsonl(sessionMessagesPath(this.rootDir, sessionId), row)
    this.appendWorklog(sessionId, { type: "message", summary: `${role === "user" ? "User" : role === "assistant" ? "Assistant" : "System"}: ${text.replace(/\s+/g, " ").trim().slice(0, 160)}` })
    return id
  }

  appendWorklog(sessionId: string, entry: Omit<SessionWorklogEntry, "at"> & { at?: string }) {
    const meta = this.readSessionMeta(sessionId)
    if (!meta) return
    const at = entry.at ?? new Date().toISOString()
    meta.updated_at = at
    this.writeSessionMeta(meta)
    appendJsonl(sessionWorklogPath(this.rootDir, sessionId), {
      type: entry.type,
      summary: entry.summary.slice(0, 220),
      at,
    })
  }

  resetSession(sessionId: string, summary = "Session reset via /new") {
    const meta = this.readSessionMeta(sessionId)
    if (!meta) return
    const now = new Date().toISOString()
    writeJsonlAtomic(sessionMessagesPath(this.rootDir, sessionId), [])
    writeJsonlAtomic(sessionWorklogPath(this.rootDir, sessionId), [])
    writeJsonlAtomic(sessionEventsPath(this.rootDir, sessionId), [])
    writeJsonAtomic(sessionTasksPath(this.rootDir, sessionId), { tasks: [] })
    writeJsonAtomic(sessionSourcesPath(this.rootDir, sessionId), { sources: {} })
    meta.next_message_id = 1
    meta.updated_at = now
    this.writeSessionMeta(meta)
    this.appendWorklog(sessionId, { type: "session", summary })
  }

  setSessionState(sessionId: string, state: SessionRecord["state"]) {
    const meta = this.readSessionMeta(sessionId)
    if (!meta) return
    meta.state = state
    meta.updated_at = new Date().toISOString()
    this.writeSessionMeta(meta)
  }

  setVoiceMode(sessionId: string, enabled: boolean) {
    const meta = this.readSessionMeta(sessionId)
    if (!meta) return
    meta.voice_mode = enabled
    meta.updated_at = new Date().toISOString()
    this.writeSessionMeta(meta)
  }

  recoverRunningSessions(summary = "Recovered after daemon restart"): string[] {
    const recovered: string[] = []
    for (const s of this.listSessions()) {
      if (s.state !== "running") continue
      this.setSessionState(s.id, "idle")
      this.appendWorklog(s.id, { type: "note", summary })
      recovered.push(s.id)
    }
    return recovered
  }

  tailEvents(sessionId: string, lines = 40): AgentEvent[] {
    const rows = readJsonl<AgentEvent>(sessionEventsPath(this.rootDir, sessionId))
    return rows.slice(-lines)
  }

  appendEvent(event: AgentEvent) {
    appendJsonl(sessionEventsPath(this.rootDir, event.sessionId), event)
  }

  getRawMessagesForSession(sessionId: string) {
    return this.readMessages(sessionId).map(m => ({
      id: m.id,
      role: m.role,
      text: m.text,
      at: m.at,
      is_compacted: m.is_compacted ?? 0,
    }))
  }

  rewriteMessageInPlace(messageId: number, text: string, isCompacted = 1, sessionId?: string) {
    const sessions = sessionId ? [sessionId] : readdirSync(sessionsDir(this.rootDir))
    for (const sid of sessions) {
      const path = sessionMessagesPath(this.rootDir, sid)
      const rows = readJsonl<FileMessageRow>(path)
      const idx = rows.findIndex(r => r.id === messageId)
      if (idx >= 0) {
        rows[idx]!.text = text
        rows[idx]!.is_compacted = isCompacted
        writeJsonlAtomic(path, rows)
        return
      }
    }
  }

  deleteMessages(messageIds: number[], sessionId?: string) {
    if (messageIds.length === 0) return
    const idSet = new Set(messageIds)
    const sessions = sessionId ? [sessionId] : readdirSync(sessionsDir(this.rootDir))
    for (const sid of sessions) {
      const path = sessionMessagesPath(this.rootDir, sid)
      const rows = readJsonl<FileMessageRow>(path)
      const filtered = rows.filter(r => !idSet.has(r.id))
      if (filtered.length !== rows.length) writeJsonlAtomic(path, filtered)
    }
  }

  compactSession(sessionId: string, options: { maxMessages?: number } = {}): { compacted: number; remaining: number } {
    const maxMessages = options.maxMessages ?? 40
    const rows = this.readMessages(sessionId)
    const totalMessages = rows.length
    const COMPACT_PROTECTED_TAIL = 5
    const COMPACT_SNIP_THRESHOLD_CHARS = 3_000
    const COMPACT_SNIP_TARGET_CHARS = 1_000
    const COMPACT_SNIP_SUFFIX = "\n...[snipped by compaction]"

    const tailIds = new Set(rows.slice(-COMPACT_PROTECTED_TAIL).map(r => r.id))
    let snipped = 0
    const updated = rows.map(m => {
      if (tailIds.has(m.id)) return m
      if (m.text.length > COMPACT_SNIP_THRESHOLD_CHARS && !m.text.includes(COMPACT_SNIP_SUFFIX)) {
        snipped++
        return { ...m, text: m.text.slice(0, COMPACT_SNIP_TARGET_CHARS) + COMPACT_SNIP_SUFFIX, is_compacted: 1 }
      }
      return m
    })
    if (snipped > 0) {
      writeJsonlAtomic(sessionMessagesPath(this.rootDir, sessionId), updated)
      return { compacted: snipped, remaining: totalMessages }
    }
    if (totalMessages <= maxMessages) return { compacted: 0, remaining: totalMessages }

    const toRemove = totalMessages - maxMessages
    const removed = updated.slice(0, toRemove)
    const kept = updated.slice(toRemove)
    const userCount = removed.filter(m => m.role === "user").length
    const assistantCount = removed.filter(m => m.role === "assistant").length
    const systemCount = removed.filter(m => m.role === "system").length
    const markers: FileMessageRow[] = []
    if (systemCount > 0) {
      markers.push({
        id: kept[0]?.id ?? 1,
        role: "system",
        text: `[${systemCount} system message${systemCount > 1 ? "s" : ""} from earlier in session]`,
        at: removed[0]?.at ?? new Date().toISOString(),
        is_compacted: 1,
      })
    }
    if (userCount > 0) {
      markers.push({
        id: kept[0]?.id ?? 1,
        role: "assistant",
        text: `[${userCount} earlier user message${userCount > 1 ? "s" : ""} compacted]`,
        at: removed[0]?.at ?? new Date().toISOString(),
        is_compacted: 1,
      })
    }
    if (assistantCount > 0) {
      markers.push({
        id: kept[0]?.id ?? 1,
        role: "assistant",
        text: `[${assistantCount} earlier assistant message${assistantCount > 1 ? "s" : ""} compacted]`,
        at: removed[0]?.at ?? new Date().toISOString(),
        is_compacted: 1,
      })
    }
    const meta = this.readSessionMeta(sessionId)
    let nextId = meta?.next_message_id ?? kept.length + 1
    const finalRows = [...markers.map(m => ({ ...m, id: nextId++ })), ...kept]
    if (meta) {
      meta.next_message_id = nextId
      this.writeSessionMeta(meta)
    }
    writeJsonlAtomic(sessionMessagesPath(this.rootDir, sessionId), finalRows)
    return { compacted: removed.length, remaining: finalRows.length }
  }

  searchMessages(query: string, limit = 10) {
    const tokens = query
      .replace(/["^*()\[\]:]/g, " ")
      .split(/\s+/)
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length >= 2)
    if (tokens.length === 0) return []
    if (!existsSync(sessionsDir(this.rootDir))) return []

    type Hit = { id: number; session_id: string; role: string; text: string; at: string; score: number }
    const hits: Hit[] = []
    for (const sessionId of readdirSync(sessionsDir(this.rootDir))) {
      if (sessionId.startsWith("agent-") || sessionId.startsWith("worker-")) continue
      for (const m of this.readMessages(sessionId)) {
        if (m.role === "system") continue
        const lower = m.text.toLowerCase()
        const score = tokens.filter(t => lower.includes(t)).length
        if (score > 0) hits.push({ id: m.id, session_id: sessionId, role: m.role, text: m.text, at: m.at, score })
      }
    }
    hits.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at))
    return hits.slice(0, limit).map(({ score: _s, ...rest }) => rest)
  }

  // --- session-scoped state (tasks, sources, prefs) ---

  private readTasksFile(sessionId: string): { tasks: Array<{ id: string; content: string; superseded_at: string | null }> } {
    const path = sessionTasksPath(this.rootDir, sessionId)
    return readJsonFile(path, { tasks: [] })
  }

  private writeTasksFile(sessionId: string, data: { tasks: Array<{ id: string; content: string; superseded_at: string | null }> }) {
    this.ensureSessionDir(sessionId)
    writeJsonAtomic(sessionTasksPath(this.rootDir, sessionId), data)
  }

  writeSessionTask(sessionId: string, taskId: string, task: FileSessionTask) {
    this.ensureSessionDir(sessionId)
    const file = this.readTasksFile(sessionId)
    const now = new Date().toISOString()
    const idx = file.tasks.findIndex(t => t.id === taskId && !t.superseded_at)
    const row = { id: taskId, content: JSON.stringify(task), superseded_at: null as string | null }
    if (idx >= 0) file.tasks[idx] = row
    else file.tasks.push(row)
    this.writeTasksFile(sessionId, file)
    void now
  }

  listSessionTasks(sessionId: string): FileSessionTask[] {
    const file = this.readTasksFile(sessionId)
    const tasks: FileSessionTask[] = []
    for (const row of file.tasks) {
      if (row.superseded_at) continue
      try {
        tasks.push(JSON.parse(row.content) as FileSessionTask)
      } catch { /* skip */ }
    }
    return tasks
  }

  deleteSessionTask(sessionId: string, taskId: string) {
    const file = this.readTasksFile(sessionId)
    const now = new Date().toISOString()
    for (const t of file.tasks) {
      if (t.id === taskId && !t.superseded_at) t.superseded_at = now
    }
    this.writeTasksFile(sessionId, file)
  }

  supersedeAllSessionTasks(sessionId: string) {
    const file = this.readTasksFile(sessionId)
    const now = new Date().toISOString()
    for (const t of file.tasks) {
      if (!t.superseded_at) t.superseded_at = now
    }
    this.writeTasksFile(sessionId, file)
  }

  writeSessionSource(sessionId: string, sourceKey: string, content: string) {
    this.ensureSessionDir(sessionId)
    const path = sessionSourcesPath(this.rootDir, sessionId)
    const data = readJsonFile<{ sources: Record<string, string> }>(path, { sources: {} })
    data.sources[sourceKey] = content
    writeJsonAtomic(path, data)
  }

  readSessionSources(sessionId: string): Array<{ key: string; content: string }> {
    const path = sessionSourcesPath(this.rootDir, sessionId)
    const data = readJsonFile<{ sources: Record<string, string> }>(path, { sources: {} })
    return Object.entries(data.sources).map(([key, content]) => ({ key, content }))
  }

  isSessionResearchSilent(sessionId: string): boolean {
    const prefs = readJsonFile<{ pref_silent_research?: string }>(sessionPrefsPath(this.rootDir, sessionId), {})
    return prefs.pref_silent_research === "true"
  }

  // --- global state ---

  appendActionLog(action: string, details?: Record<string, unknown>) {
    appendJsonl(actionLogPath(this.rootDir), { action, details: details ?? {}, at: new Date().toISOString() })
  }

  addGraphTriple(profileId: string, subject: string, predicate: string, object: string, validFrom: string): string {
    const id = randomUUID()
    appendJsonl(graphPath(this.rootDir), {
      id,
      profile_id: profileId,
      subject: subject.trim(),
      predicate: predicate.trim(),
      object: object.trim(),
      valid_from: validFrom,
      valid_to: null,
      created_at: new Date().toISOString(),
    })
    return id
  }

  invalidateGraphTriple(profileId: string, subject: string, predicate: string, object: string, validTo: string) {
    const rows = readJsonl<{
      id: string
      profile_id: string
      subject: string
      predicate: string
      object: string
      valid_from: string
      valid_to: string | null
      created_at: string
    }>(graphPath(this.rootDir))
    let changes = 0
    for (const row of rows) {
      if (
        row.profile_id === profileId &&
        row.subject === subject.trim() &&
        row.predicate === predicate.trim() &&
        row.object === object.trim() &&
        row.valid_to === null
      ) {
        row.valid_to = validTo
        changes++
      }
    }
    writeJsonlAtomic(graphPath(this.rootDir), rows)
    return { changes }
  }

  queryGraphEntity(profileId: string, entity: string): FileKnowledgeGraphTriple[] {
    const ent = entity.trim()
    return readJsonl<FileKnowledgeGraphTriple>(graphPath(this.rootDir))
      .filter(r => r.profile_id === profileId && (r.subject === ent || r.object === ent))
      .map(r => ({ ...r, is_active: r.valid_to === null }))
      .sort((a, b) => {
        const aActive = a.valid_to === null ? 0 : 1
        const bActive = b.valid_to === null ? 0 : 1
        if (aActive !== bActive) return aActive - bActive
        return b.valid_from.localeCompare(a.valid_from)
      })
  }

  upsertRalphRule(key: string, ruleJson: string) {
    const path = ralphRulesPath(this.rootDir)
    const rules = readJsonFile<Record<string, string>>(path, {})
    if (rules[key] === ruleJson) return
    rules[key] = ruleJson
    writeJsonAtomic(path, rules)
  }

  listRalphRules(): Array<{ key: string; content: string }> {
    const rules = readJsonFile<Record<string, string>>(ralphRulesPath(this.rootDir), {})
    return Object.entries(rules).map(([key, content]) => ({ key, content }))
  }

  upsertSemanticTool(name: string, description: string) {
    const path = semanticToolsPath(this.rootDir)
    const tools = readJsonFile<Record<string, string>>(path, {})
    if (tools[name] === description) return
    tools[name] = description
    writeJsonAtomic(path, tools)
  }

  querySemanticTools(prompt: string, limit = 5): string[] {
    const tools = readJsonFile<Record<string, string>>(semanticToolsPath(this.rootDir), {})
    const tokens = prompt.toLowerCase().split(/\s+/).filter(t => t.length >= 2)
    const scored = Object.entries(tools).map(([name, desc]) => {
      const hay = `${name} ${desc}`.toLowerCase()
      const score = tokens.length === 0 ? 1 : tokens.filter(t => hay.includes(t)).length
      return { name, score }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.filter(s => s.score > 0).slice(0, limit).map(s => s.name)
  }

  getMemorySectionCount(): number {
    const path = memoryMdPath(this.rootDir)
    if (!existsSync(path)) return 0
    const md = readFileSync(path, "utf8")
    return md.split(/\n(?=## )/).filter(s => s.trim().startsWith("## ")).length
  }

  getMemoryConsolidationCursor(): number {
    const data = readJsonFile<{ last_message_id?: number }>(memoryAgentCursorPath(this.rootDir), {})
    return data.last_message_id ?? 0
  }

  setMemoryConsolidationCursor(messageId: number) {
    writeJsonAtomic(memoryAgentCursorPath(this.rootDir), { last_message_id: messageId, updated_at: new Date().toISOString() })
  }

  getMessagesSinceId(sessionId: string, afterId: number) {
    return this.readMessages(sessionId)
      .filter(m => m.id > afterId)
      .map(m => ({ id: m.id, role: m.role, text: m.text, at: m.at }))
  }

  clearProfileMemory() {
    const graphRows = readJsonl(graphPath(this.rootDir)).length
    if (existsSync(graphPath(this.rootDir))) writeJsonlAtomic(graphPath(this.rootDir), [])
    writeJsonAtomic(resolvedErrorsPath(this.rootDir), {})
    return { memorySectionsCleared: 0, graphRowsDeleted: graphRows }
  }

  saveResolvedError(errorSnippet: string, solutionSnippet: string) {
    const key = createHash("sha256").update(errorSnippet.trim()).digest("hex")
    const path = resolvedErrorsPath(this.rootDir)
    const errors = readJsonFile<Record<string, { error: string; solution: string }>>(path, {})
    errors[key] = { error: errorSnippet, solution: solutionSnippet }
    writeJsonAtomic(path, errors)
  }

  findSimilarResolvedError(errorSnippet: string): string | null {
    const path = resolvedErrorsPath(this.rootDir)
    const errors = readJsonFile<Record<string, { error: string; solution: string }>>(path, {})
    const needle = errorSnippet.trim().toLowerCase().slice(0, 200)
    for (const entry of Object.values(errors)) {
      if (entry.error.toLowerCase().includes(needle.slice(0, 80))) return entry.solution
    }
    return null
  }

  // --- telegram ---

  persistTelegramUpdate(updateId: number, chatId: number | null, rawJson: string): { ok: boolean; error?: string } {
    try {
      const existing = readJsonl<FileTelegramUpdate>(telegramUpdatesPath(this.rootDir))
      if (existing.some(u => u.update_id === updateId)) return { ok: true }
      appendJsonl(telegramUpdatesPath(this.rootDir), {
        update_id: updateId,
        chat_id: chatId,
        received_at: new Date().toISOString(),
        processed_at: null,
        raw_json: rawJson,
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  markTelegramUpdateProcessed(updateId: number) {
    const path = telegramUpdatesPath(this.rootDir)
    const rows = readJsonl<FileTelegramUpdate>(path)
    const now = new Date().toISOString()
    for (const row of rows) {
      if (row.update_id === updateId) row.processed_at = now
    }
    writeJsonlAtomic(path, rows)
  }

  countUnprocessedTelegramUpdates(): number {
    return readJsonl<FileTelegramUpdate>(telegramUpdatesPath(this.rootDir)).filter(u => !u.processed_at).length
  }

  persistTelegramSentPhoto(row: {
    chatId: number
    messageId: number
    fileId: string | null
    localPath: string
    caption: string | null
  }) {
    const existing = readJsonl<FileTelegramSentPhoto>(telegramSentPhotosPath(this.rootDir))
    const id = existing.length > 0 ? Math.max(...existing.map(r => r.id)) + 1 : 1
    appendJsonl(telegramSentPhotosPath(this.rootDir), {
      id,
      chat_id: row.chatId,
      message_id: row.messageId,
      file_id: row.fileId,
      local_path: row.localPath,
      caption: row.caption,
      sent_at: new Date().toISOString(),
    })
  }

  listTelegramSentPhotos(chatId: number | null, limit: number) {
    let rows = readJsonl<FileTelegramSentPhoto>(telegramSentPhotosPath(this.rootDir))
    if (chatId !== null) rows = rows.filter(r => r.chat_id === chatId)
    rows.sort((a, b) => b.sent_at.localeCompare(a.sent_at) || b.id - a.id)
    return rows.slice(0, limit)
  }

  writeModelConfigNote(content: string) {
    writeFileSync(modelConfigPath(this.rootDir), content, "utf8")
  }

  readModelConfigNote(): string | null {
    const path = modelConfigPath(this.rootDir)
    if (!existsSync(path)) return null
    return readFileSync(path, "utf8")
  }

  /** Wipe session dir entirely (for tests). */
  deleteSession(sessionId: string) {
    rmSync(sessionDir(this.rootDir, sessionId), { recursive: true, force: true })
  }
}
