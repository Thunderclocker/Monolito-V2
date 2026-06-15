import { randomUUID } from "node:crypto"
import {
  type AgentEvent,
  type SessionRecord,
  type SessionSummary,
  type SessionWorklogEntry,
} from "../ipc/protocol.ts"
import { type BootWingEntry, DEFAULT_BOOT_WING_CONTENT } from "../bootstrap/bootWings.ts"
import { type ConfigWingName, type ConfigWingValueMap } from "../config/configWings.ts"
import { createLogger } from "../logging/logger.ts"
import { createMarkdownMemoryStore, getFileStorage } from "../storage/index.ts"

function fileStore(rootDir: string) {
  return getFileStorage(rootDir)
}

function markdownStore(rootDir: string) {
  return createMarkdownMemoryStore(rootDir)
}

const logger = createLogger("store")
const WORKER_SESSION_PREFIXES = ["agent-"] as const

export function isMainSession(sessionId: string): boolean {
  return !WORKER_SESSION_PREFIXES.some(prefix => sessionId.startsWith(prefix))
}

export type KnowledgeGraphTriple = {
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

export function writeSessionSource(
  rootDir: string,
  sessionId: string,
  sourceKey: string,
  content: string,
  _profileId: string = "default",
) {
  fileStore(rootDir).writeSessionSource(sessionId, sourceKey, content)
}

export function readSessionSources(
  rootDir: string,
  sessionId: string,
  _profileId: string = "default",
): Array<{ key: string; content: string }> {
  return fileStore(rootDir).readSessionSources(sessionId)
}

export interface SessionTask {
  id: string
  content: string
  activeForm?: string
  status: "pending" | "in_progress" | "completed"
  createdAt: string
  updatedAt?: string
  sessionId?: string
  category?: "cognitive" | "life"
}

export function writeSessionTask(
  rootDir: string,
  sessionId: string,
  taskId: string,
  task: SessionTask,
  _profileId: string = "default",
) {
  fileStore(rootDir).writeSessionTask(sessionId, taskId, task)
}

export function listSessionTasks(
  rootDir: string,
  sessionId: string,
  _profileId: string = "default",
): SessionTask[] {
  return fileStore(rootDir).listSessionTasks(sessionId)
}

export function deleteSessionTask(
  rootDir: string,
  sessionId: string,
  taskId: string,
  _profileId: string = "default",
) {
  fileStore(rootDir).deleteSessionTask(sessionId, taskId)
}

export function supersedeAllSessionTasks(
  rootDir: string,
  sessionId: string,
  _profileId: string = "default",
) {
  fileStore(rootDir).supersedeAllSessionTasks(sessionId)
}

export function ensureKernelSeeded(rootDir: string, profileId = "default") {
  fileStore(rootDir).ensureKernelSeeded()
  ensureBootWings(rootDir, profileId)
}

export function ensureBootWings(rootDir: string, _profileId = "default") {
  markdownStore(rootDir).ensureSeeded()
}

export function loadCachedMemoryContext(rootDir: string): string | null {
  return markdownStore(rootDir).buildCachedContextBlock()
}

export function ensureConfigWings(rootDir: string) {
  fileStore(rootDir).ensureKernelSeeded()
}

export function readConfigWing<T extends ConfigWingName>(rootDir: string, wing: T): ConfigWingValueMap[T] {
  return fileStore(rootDir).readConfigWing(wing)
}

export function writeConfigWing<T extends ConfigWingName>(rootDir: string, wing: T, value: ConfigWingValueMap[T]) {
  return fileStore(rootDir).writeConfigWing(wing, value)
}

export function appendActionLog(rootDir: string, action: string, details?: Record<string, unknown>) {
  fileStore(rootDir).appendActionLog(action, details)
}

export function listBootWings(rootDir: string, profileId = "default"): string[] {
  ensureBootWings(rootDir, profileId)
  return markdownStore(rootDir).listBootWings()
}

export function bootWingExists(rootDir: string, wing: string, profileId = "default"): boolean {
  ensureBootWings(rootDir, profileId)
  return markdownStore(rootDir).bootWingExists(wing)
}

export function createBootWing(rootDir: string, wing: string, profileId = "default", content = "") {
  ensureBootWings(rootDir, profileId)
  const normalizedWing = wing.trim()
  if (!normalizedWing) throw new Error("BOOT wing must be a non-empty string")
  if (bootWingExists(rootDir, normalizedWing, profileId)) {
    return { created: false, wing: normalizedWing, profile: profileId }
  }
  markdownStore(rootDir).writeBootWing(normalizedWing, content || "")
  return { created: true, wing: normalizedWing, profile: profileId }
}

export function readBootWing(rootDir: string, wing: string, profileId = "default"): string | null {
  ensureBootWings(rootDir, profileId)
  return markdownStore(rootDir).readBootWing(wing)
}

export function writeBootWing(rootDir: string, wing: string, content: string, profileId = "default", append = false) {
  ensureBootWings(rootDir, profileId)
  if (!bootWingExists(rootDir, wing, profileId)) {
    throw new Error(`BOOT wing ${wing} does not exist in profile ${profileId}. Use BootCreateWing after BootListWings if you need a new wing.`)
  }
  markdownStore(rootDir).writeBootWing(wing, content, append)
  return { changed: true, bytes: Buffer.byteLength(content, "utf8") }
}

export function listBootEntries(
  rootDir: string,
  profileId = "default",
  options?: { includeMemory?: boolean; maxCharsPerEntry?: number; maxTotalChars?: number },
) {
  ensureBootWings(rootDir, profileId)
  const includeMemory = options?.includeMemory ?? true
  const maxCharsPerEntry = options?.maxCharsPerEntry ?? 20_000
  let remainingChars = options?.maxTotalChars ?? 150_000
  const entries: BootWingEntry[] = []

  for (const wing of listBootWings(rootDir, profileId)) {
    if (!includeMemory && wing === "BOOT_MEMORY") continue
    if (remainingChars <= 0) break
    const content = readBootWing(rootDir, wing, profileId)?.trim() ?? ""
    if (!content) continue
    const maxChars = Math.max(1, Math.min(maxCharsPerEntry, remainingChars))
    const truncated =
      content.length > maxChars
        ? { content: `${content.slice(0, maxChars).trimEnd()}\n\n[truncated]`, truncated: true }
        : { content, truncated: false }
    entries.push({ wing, content: truncated.content, truncated: truncated.truncated })
    remainingChars -= truncated.content.length
  }

  return entries
}

function truncateSummary(text: string, max = 160) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1).trimEnd()}...`
}

function buildMessageSummary(role: "user" | "assistant" | "system", text: string) {
  const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : "System"
  return `${label}: ${truncateSummary(text)}`
}

export function createSession(
  rootDir: string,
  title = "Monolito v2 Session",
  sessionId?: string,
  profileId = "default",
): SessionRecord {
  return fileStore(rootDir).createSession(title, sessionId, profileId)
}

export function updateSessionProfile(rootDir: string, sessionId: string, profileId: string) {
  fileStore(rootDir).updateSessionProfile(sessionId, profileId)
}

export function saveSession(rootDir: string, session: SessionRecord) {
  fileStore(rootDir).saveSession(session)
}

export function getSession(rootDir: string, sessionId: string): SessionRecord | null {
  return fileStore(rootDir).getSession(sessionId)
}

export function ensureSession(rootDir: string, sessionId?: string, title?: string) {
  if (sessionId) {
    const existing = getSession(rootDir, sessionId)
    if (existing) return existing
  }
  return createSession(rootDir, title, sessionId)
}

export function listSessions(rootDir: string, profileId?: string): SessionSummary[] {
  return fileStore(rootDir).listSessions(profileId)
}

export function listSessionRecords(rootDir: string): SessionRecord[] {
  return listSessions(rootDir).map(s => getSession(rootDir, s.id)!)
}

export function getSemanticMessageContext(rootDir: string, query: string, limit = 10) {
  return fileStore(rootDir).searchMessages(query, limit)
}

export interface AppendMessageOptions {
  hiddenFromUser?: boolean
  thinking?: string
}

export function appendMessage(
  rootDir: string,
  sessionId: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: AppendMessageOptions = {},
) {
  fileStore(rootDir).appendMessage(sessionId, role, text, options)
}

export function appendWorklog(
  rootDir: string,
  sessionId: string,
  entry: Omit<SessionWorklogEntry, "at"> & { at?: string },
) {
  fileStore(rootDir).appendWorklog(sessionId, entry)
}

export function resetSession(rootDir: string, sessionId: string, options?: { summary?: string }) {
  fileStore(rootDir).resetSession(sessionId, options?.summary)
}

export function clearProfileMemory(rootDir: string, profileId = "default") {
  const result = fileStore(rootDir).clearProfileMemory()
  const md = markdownStore(rootDir)
  md.ensureSeeded()
  const sectionsBefore = md.loadMemoryMd().split(/\n(?=## )/).filter(s => s.trim().startsWith("## ")).length
  md.writeBootWing("BOOT_MEMORY", DEFAULT_BOOT_WING_CONTENT.BOOT_MEMORY)
  ensureBootWings(rootDir, profileId)
  return {
    ...result,
    memorySectionsCleared: result.memorySectionsCleared + sectionsBefore,
  }
}

export function setSessionState(rootDir: string, sessionId: string, state: SessionRecord["state"]) {
  fileStore(rootDir).setSessionState(sessionId, state)
}

export function recoverRunningSessions(rootDir: string, summary = "Recovered after daemon restart") {
  return fileStore(rootDir).recoverRunningSessions(summary)
}

export function tailEvents(rootDir: string, sessionId: string, lines = 40): AgentEvent[] {
  return fileStore(rootDir).tailEvents(sessionId, lines)
}

export function appendEvent(rootDir: string, event: AgentEvent) {
  fileStore(rootDir).appendEvent(event)
}

type CompactOptions = {
  maxMessages?: number
}

export function compactSession(
  rootDir: string,
  sessionId: string,
  options: CompactOptions = {},
): { compacted: number; remaining: number } {
  return fileStore(rootDir).compactSession(sessionId, options)
}

export function getSessionStats(rootDir: string, sessionId: string) {
  const session = getSession(rootDir, sessionId)
  if (!session) return null
  const totalChars = session.messages.reduce((sum, m) => sum + m.text.length, 0)
  return {
    id: session.id,
    messageCount: session.messages.length,
    totalChars,
    worklogEntries: session.worklog.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    state: session.state,
  }
}

export async function fileMemory(
  rootDir: string,
  namespace: string,
  section: string,
  content: string,
  profileId = "default",
  key?: string,
) {
  const rawNamespace = namespace.trim()
  if (rawNamespace.toUpperCase().startsWith("BOOT_")) {
    throw new Error("BOOT_* wings are reserved for deterministic bootstrap state. Use BootWrite instead.")
  }
  if (rawNamespace.toUpperCase().startsWith("CONF_")) {
    throw new Error("CONF_* wings are reserved for technical configuration state. Use ConfigWrite/tool_manage_config instead.")
  }
  const normalizedSection = section.trim() || "general"
  const sectionTitle = key?.trim() ? `${normalizedSection} — ${key.trim()}` : normalizedSection
  const tags = [rawNamespace || "SHARED", normalizedSection].filter(Boolean)
  markdownStore(rootDir).upsertMemorySection(sectionTitle, content, tags)
  return randomUUID()
}

export async function upsertCuratedMemory(
  rootDir: string,
  namespace: string,
  section: string,
  content: string,
  profileId: string = "default",
  key: string | undefined,
): Promise<{ id: string; action: "inserted" | "updated" | "skipped" }> {
  const rawNamespace = namespace.trim()
  if (rawNamespace.toUpperCase().startsWith("BOOT_")) {
    throw new Error("BOOT_* wings are reserved for deterministic bootstrap state. Use BootWrite instead.")
  }
  if (rawNamespace.toUpperCase().startsWith("CONF_")) {
    throw new Error("CONF_* wings are reserved for technical configuration state. Use ConfigWrite/tool_manage_config instead.")
  }
  const normalizedNamespace = rawNamespace.length === 0 ? "PRIVATE" : rawNamespace.toUpperCase() === "SHARED" ? "SHARED" : rawNamespace
  const normalizedSection = section.trim() || "general"
  const normalizedKey = key?.trim() || null
  const sectionTitle = normalizedKey ? `${normalizedSection} — ${normalizedKey}` : normalizedSection
  const tags = [normalizedNamespace, normalizedSection].filter(Boolean)
  const result = markdownStore(rootDir).upsertMemorySection(sectionTitle, content, tags)
  return { id: randomUUID(), action: result.action }
}

export async function recallMemory(
  rootDir: string,
  namespace?: string,
  section?: string,
  query?: string,
  _profileId?: string,
  key?: string,
) {
  const store = markdownStore(rootDir)
  const md = store.loadMemoryMd()
  const sections = md.split(/\n(?=## )/).filter(s => s.trim().startsWith("## "))
  const tokens = (query ?? section ?? key ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length >= 2)
  const scored = sections
    .map(raw => {
      const lower = raw.toLowerCase()
      const score = tokens.length === 0 ? 1 : tokens.filter(t => lower.includes(t)).length
      const titleMatch = raw.match(/^##\s+(.+)/)
      const title = titleMatch?.[1]?.trim() ?? "section"
      return {
        score,
        namespace: namespace ?? "SHARED",
        section: section ?? title,
        key: key ?? title,
        content: raw.trim(),
        created_at: new Date().toISOString(),
        rank: score,
      }
    })
    .filter(r => tokens.length === 0 || r.score > 0)
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 15)
}

export function listProfiles(rootDir: string) {
  return fileStore(rootDir).listProfiles()
}

export function createProfile(rootDir: string, id: string, name: string, description?: string) {
  return fileStore(rootDir).createProfile(id, name, description)
}

export function listMemoryNamespaces(rootDir: string, _profileId?: string): string[] {
  return ["SHARED", "memory"]
}

export function listMemorySections(rootDir: string, _namespace: string, _profileId?: string): string[] {
  const md = markdownStore(rootDir).loadMemoryMd()
  return md
    .split(/\n(?=## )/)
    .filter(s => s.trim().startsWith("## "))
    .map(s => (s.match(/^##\s+(.+)/)?.[1]?.trim() ?? ""))
    .filter(Boolean)
}

export function addGraphTriple(
  rootDir: string,
  profileId: string,
  subject: string,
  predicate: string,
  object: string,
  validFrom: string,
) {
  return fileStore(rootDir).addGraphTriple(profileId, subject, predicate, object, validFrom)
}

export function invalidateGraphTriple(
  rootDir: string,
  profileId: string,
  subject: string,
  predicate: string,
  object: string,
  validTo: string,
) {
  return fileStore(rootDir).invalidateGraphTriple(profileId, subject, predicate, object, validTo)
}

export function queryGraphEntity(rootDir: string, profileId: string, entity: string): KnowledgeGraphTriple[] {
  return fileStore(rootDir).queryGraphEntity(profileId, entity)
}

export async function upsertSemanticTool(rootDir: string, name: string, description: string): Promise<void> {
  fileStore(rootDir).upsertSemanticTool(name, description)
}

export async function querySemanticTools(rootDir: string, prompt: string, limit = 5): Promise<string[]> {
  if (!rootDir || typeof rootDir !== "string") return []
  try {
    return fileStore(rootDir).querySemanticTools(prompt, limit)
  } catch (error) {
    logger.error(`Error querying tools for prompt: ${error}`)
    return []
  }
}

export function upsertRalphRule(rootDir: string, key: string, ruleJson: string): void {
  fileStore(rootDir).upsertRalphRule(key, ruleJson)
}

export function listRalphRules(rootDir: string): Array<{ key: string; content: string }> {
  return fileStore(rootDir).listRalphRules()
}

export function isSessionResearchSilent(rootDir: string, sessionId: string, _profileId = "default"): boolean {
  return fileStore(rootDir).isSessionResearchSilent(sessionId)
}

export function getRawMessagesForSession(
  rootDir: string,
  sessionId: string,
): Array<{ id: number; role: string; text: string; at: string; is_compacted: number }> {
  return fileStore(rootDir).getRawMessagesForSession(sessionId)
}

export function rewriteMessageInPlace(
  rootDir: string,
  messageId: number,
  text: string,
  isCompacted: number = 1,
  sessionId?: string,
) {
  fileStore(rootDir).rewriteMessageInPlace(messageId, text, isCompacted, sessionId)
}

export function deleteMessages(rootDir: string, messageIds: number[], sessionId?: string) {
  fileStore(rootDir).deleteMessages(messageIds, sessionId)
}

export async function saveResolvedError(rootDir: string, errorSnippet: string, solutionSnippet: string): Promise<void> {
  fileStore(rootDir).saveResolvedError(errorSnippet, solutionSnippet)
}

export async function querySimilarErrors(
  rootDir: string,
  errorSnippet: string,
  _limit = 1,
): Promise<{ error: string; solution: string } | null> {
  const solution = fileStore(rootDir).findSimilarResolvedError(errorSnippet)
  return solution ? { error: errorSnippet, solution } : null
}

export function persistTelegramUpdate(
  rootDir: string,
  updateId: number,
  chatId: number | null,
  rawJson: string,
): { ok: boolean; error?: string } {
  return fileStore(rootDir).persistTelegramUpdate(updateId, chatId, rawJson)
}

export function markTelegramUpdateProcessed(rootDir: string, updateId: number): void {
  fileStore(rootDir).markTelegramUpdateProcessed(updateId)
}

export function countUnprocessedTelegramUpdates(rootDir: string): number {
  return fileStore(rootDir).countUnprocessedTelegramUpdates()
}

export function getMemoryConsolidationCursor(rootDir: string): number {
  return fileStore(rootDir).getMemoryConsolidationCursor()
}

export function setMemoryConsolidationCursor(rootDir: string, messageId: number, _profileId = "default"): void {
  fileStore(rootDir).setMemoryConsolidationCursor(messageId)
}

export function getMessagesSinceId(
  rootDir: string,
  sessionId: string,
  afterId: number,
): Array<{ id: number; role: string; text: string; at: string }> {
  return fileStore(rootDir).getMessagesSinceId(sessionId, afterId)
}

export function getMemorySectionCount(rootDir: string): number {
  return fileStore(rootDir).getMemorySectionCount()
}

export function setSessionVoiceMode(rootDir: string, sessionId: string, enabled: boolean): void {
  fileStore(rootDir).setVoiceMode(sessionId, enabled)
}

export function persistTelegramSentPhoto(
  rootDir: string,
  row: { chatId: number; messageId: number; fileId: string | null; localPath: string; caption: string | null },
): void {
  fileStore(rootDir).persistTelegramSentPhoto(row)
}

export function listTelegramSentPhotos(
  rootDir: string,
  chatId: number | null,
  limit: number,
): Array<{
  id: number
  chat_id: number
  message_id: number
  file_id: string | null
  local_path: string
  caption: string | null
  sent_at: string
}> {
  return fileStore(rootDir).listTelegramSentPhotos(chatId, limit)
}

/** Runtime boot: persist active model profile note for prompt context. */
export function reconcileModelConfigNote(rootDir: string, content: string): void {
  fileStore(rootDir).writeModelConfigNote(content)
}

export function readModelConfigNote(rootDir: string): string | null {
  return fileStore(rootDir).readModelConfigNote()
}
