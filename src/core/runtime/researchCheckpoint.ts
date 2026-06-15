import type { AssistantTurnStep } from "./modelAdapter.ts"
import {
  listSessionTasks,
  readResearchCheckpoint,
  readSessionSources,
  writeResearchCheckpoint,
  type ResearchCheckpointFile,
} from "../session/store.ts"

export const RESEARCH_CHECKPOINT_TOOLS = new Set(["WebSearch", "WebFetch", "ImageSearch"])
export const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000
export const CHECKPOINT_SILENT_WINDOW_MS = 5 * 60 * 1000
export const CHECKPOINT_EVIDENCE_BUDGET_CHARS = 12_000

export function hasResearchToolSteps(steps: AssistantTurnStep[] | undefined): boolean {
  return (steps ?? []).some(step => step.type === "tool" && RESEARCH_CHECKPOINT_TOOLS.has(step.tool))
}

export function listResearchToolsRun(steps: AssistantTurnStep[] | undefined): string[] {
  return (steps ?? [])
    .filter((step): step is Extract<AssistantTurnStep, { type: "tool" }> =>
      step.type === "tool" && RESEARCH_CHECKPOINT_TOOLS.has(step.tool),
    )
    .map(step => step.tool)
}

function sourceKeyTimestamp(key: string): number | null {
  const parts = key.split(":")
  if (parts.length < 2) return null
  const ts = Number.parseInt(parts[parts.length - 1]!, 10)
  return Number.isFinite(ts) ? ts : null
}

export function filterSourceKeysForTurn(
  sources: Array<{ key: string; content: string }>,
  turnStartedAtMs: number,
): string[] {
  return filterSourceKeysSince(sources, turnStartedAtMs)
}

export function filterSourceKeysSince(
  sources: Array<{ key: string; content: string }>,
  sinceMs: number,
): string[] {
  const bufferMs = 5_000
  return sources
    .filter(({ key }) => {
      const prefix = key.split(":")[0]
      if (!prefix || !RESEARCH_CHECKPOINT_TOOLS.has(prefix)) return false
      const ts = sourceKeyTimestamp(key)
      return ts === null || ts >= sinceMs - bufferMs
    })
    .map(s => s.key)
}

function buildEvidenceIndexFromSteps(steps: AssistantTurnStep[]): ResearchCheckpointFile["evidenceIndex"] {
  const index: ResearchCheckpointFile["evidenceIndex"] = []
  for (const step of steps) {
    if (step.type !== "tool" || !RESEARCH_CHECKPOINT_TOOLS.has(step.tool)) continue
    const input = step.input ?? {}
    if (step.tool === "WebSearch") {
      const query = typeof input.query === "string" ? input.query : "(query)"
      index.push({ tool: step.tool, summary: `WebSearch: ${query}` })
    } else if (step.tool === "WebFetch") {
      const url = typeof input.url === "string" ? input.url : "(url)"
      index.push({ tool: step.tool, summary: `WebFetch: ${url}`, url })
    } else if (step.tool === "ImageSearch") {
      const query = typeof input.query === "string" ? input.query : "(query)"
      index.push({ tool: step.tool, summary: `ImageSearch: ${query}` })
    }
  }
  return index
}

function buildEvidenceIndex(steps: AssistantTurnStep[]): ResearchCheckpointFile["evidenceIndex"] {
  return buildEvidenceIndexFromSteps(steps)
}

function sliceResearchSteps(steps: AssistantTurnStep[], fromIndex: number): AssistantTurnStep[] {
  const toolSteps = (steps ?? []).filter(
    (step): step is Extract<AssistantTurnStep, { type: "tool" }> => step.type === "tool",
  )
  return toolSteps.slice(fromIndex)
}

export function commitCompletedTaskItem(args: {
  rootDir: string
  sessionId: string
  profileId: string
  userRequest: string
  turnStartedAtMs: number
  task: { id: string; content: string }
  itemStartedAtMs: number
  steps: AssistantTurnStep[]
  stepsFromIndex: number
}): ResearchCheckpointFile | null {
  const itemSteps = sliceResearchSteps(args.steps, args.stepsFromIndex)
  if (!hasResearchToolSteps(itemSteps)) return null

  const sources = readSessionSources(args.rootDir, args.sessionId, args.profileId)
  const sourceKeys = filterSourceKeysSince(sources, args.itemStartedAtMs)
  const completedItem = {
    taskId: args.task.id,
    content: args.task.content,
    completedAt: new Date().toISOString(),
    toolsRun: listResearchToolsRun(itemSteps),
    sourceKeys,
    evidenceIndex: buildEvidenceIndexFromSteps(itemSteps),
    itemStartedAt: new Date(args.itemStartedAtMs).toISOString(),
  }

  const existing = readResearchCheckpoint(args.rootDir, args.sessionId)
  const completedItems = [...(existing?.completedItems ?? []), completedItem]
  const mergedSourceKeys = [...new Set([...(existing?.sourceKeys ?? []), ...sourceKeys])]
  const mergedTools = [...new Set([...(existing?.toolsRun ?? []), ...completedItem.toolsRun])]
  const mergedEvidence = [
    ...(existing?.evidenceIndex ?? []),
    ...completedItem.evidenceIndex,
  ]

  const checkpoint: ResearchCheckpointFile = {
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    userRequest: (existing?.userRequest ?? args.userRequest).slice(0, 2_000),
    reason: existing?.reason ?? "turn_aborted",
    turnStartedAt: existing?.turnStartedAt ?? new Date(args.turnStartedAtMs).toISOString(),
    toolsRun: mergedTools,
    sourceKeys: mergedSourceKeys,
    evidenceIndex: mergedEvidence,
    tasksCompleted: completedItems.length,
    consumed: false,
    completedItems,
  }

  writeResearchCheckpoint(args.rootDir, args.sessionId, checkpoint)
  return checkpoint
}

export function saveResearchCheckpointFromTurn(args: {
  rootDir: string
  sessionId: string
  profileId: string
  userRequest: string
  reason: ResearchCheckpointFile["reason"]
  turnStartedAtMs: number
  steps: AssistantTurnStep[] | undefined
}): ResearchCheckpointFile | null {
  if (!hasResearchToolSteps(args.steps)) return null

  const sources = readSessionSources(args.rootDir, args.sessionId, args.profileId)
  const sourceKeys = filterSourceKeysForTurn(sources, args.turnStartedAtMs)
  const existing = readResearchCheckpoint(args.rootDir, args.sessionId)
  const tasks = listSessionTasks(args.rootDir, args.sessionId, args.profileId)
  const tasksCompleted = Math.max(
    existing?.completedItems?.length ?? 0,
    tasks.filter(t => t.status === "completed").length,
  )

  const checkpoint: ResearchCheckpointFile = {
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    userRequest: args.userRequest.slice(0, 2_000),
    reason: args.reason,
    turnStartedAt: new Date(args.turnStartedAtMs).toISOString(),
    toolsRun: [...new Set([...(existing?.toolsRun ?? []), ...listResearchToolsRun(args.steps)])],
    sourceKeys: [...new Set([...(existing?.sourceKeys ?? []), ...sourceKeys])],
    evidenceIndex: [...(existing?.evidenceIndex ?? []), ...buildEvidenceIndex(args.steps ?? [])],
    tasksCompleted,
    consumed: false,
    completedItems: existing?.completedItems,
    failedItemLabel: existing?.failedItemLabel,
  }

  writeResearchCheckpoint(args.rootDir, args.sessionId, checkpoint)
  return checkpoint
}

function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
}

export function isResearchContinuationRequest(text: string): boolean {
  const normalized = normalizeForMatch(text)
  return /\b(reintent(a|á)|retry|segu(i|í)|continu(a|á)|contame|contá|con lo que (ya )?buscaste|con lo que investigaste|sintetiz(a|á)|termin(a|á) (el )?reporte|usa lo que ya (buscaste|encontraste|investigaste))\b/.test(normalized)
}

function topicTokens(text: string): Set<string> {
  const tokens = normalizeForMatch(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4)
  return new Set(tokens)
}

export function sharesTopicWithCheckpoint(userText: string, checkpoint: ResearchCheckpointFile): boolean {
  const userTokens = topicTokens(userText)
  const checkpointTokens = topicTokens(checkpoint.userRequest)
  if (userTokens.size === 0 || checkpointTokens.size === 0) return false
  let overlap = 0
  for (const token of userTokens) {
    if (checkpointTokens.has(token)) overlap++
  }
  return overlap >= 2
}

export function isCheckpointExpired(checkpoint: ResearchCheckpointFile, nowMs = Date.now()): boolean {
  const created = Date.parse(checkpoint.createdAt)
  if (!Number.isFinite(created)) return true
  return nowMs - created > CHECKPOINT_TTL_MS
}

export function shouldInjectResearchCheckpoint(
  userText: string,
  checkpoint: ResearchCheckpointFile | null,
  nowMs = Date.now(),
): boolean {
  if (!checkpoint || checkpoint.consumed) return false
  if (isCheckpointExpired(checkpoint, nowMs)) return false
  if (isResearchContinuationRequest(userText)) return true
  const created = Date.parse(checkpoint.createdAt)
  if (!Number.isFinite(created)) return false
  const withinSilentWindow = nowMs - created <= CHECKPOINT_SILENT_WINDOW_MS
  return withinSilentWindow && sharesTopicWithCheckpoint(userText, checkpoint)
}

function clipText(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3)}...`
}

export function formatResearchCheckpointPromptBlock(
  checkpoint: ResearchCheckpointFile,
  sources: Array<{ key: string; content: string }>,
  budgetChars = CHECKPOINT_EVIDENCE_BUDGET_CHARS,
): string {
  const sourceByKey = new Map(sources.map(s => [s.key, s.content]))
  const keys = checkpoint.sourceKeys.length > 0
    ? checkpoint.sourceKeys
    : sources.map(s => s.key).filter(k => RESEARCH_CHECKPOINT_TOOLS.has(k.split(":")[0] ?? ""))

  const perSourceBudget = keys.length > 0 ? Math.max(800, Math.floor(budgetChars / keys.length)) : budgetChars
  const evidenceLines = checkpoint.evidenceIndex.map(e => `- ${e.summary}`).join("\n")
  const completedLines = (checkpoint.completedItems ?? []).map(
    item => `- [COMPLETED] ${item.content} (${item.toolsRun.join(", ") || "tools"})`,
  ).join("\n")

  const excerpts: string[] = []
  let used = 0
  for (const key of keys) {
    if (used >= budgetChars) break
    const content = sourceByKey.get(key)
    if (!content) continue
    const room = Math.min(perSourceBudget, budgetChars - used)
    excerpts.push(`--- ${key} ---\n${clipText(content, room)}`)
    used += room
  }

  return [
    "<research_checkpoint>",
    `reason="${checkpoint.reason}" created="${checkpoint.createdAt}"`,
    `Original user request: ${checkpoint.userRequest}`,
    "",
    "Evidence already collected in the interrupted turn (index):",
    evidenceLines || "- (no index entries)",
    completedLines ? "\nTask items already completed in this turn:\n" + completedLines : "",
    "",
    "Cached source excerpts (use as primary evidence; do NOT re-run WebSearch/WebFetch unless a concrete gap remains):",
    excerpts.length > 0 ? excerpts.join("\n\n") : "(no cached excerpts available)",
    "",
    "INSTRUCTION: Synthesize the final user-facing answer using ONLY the evidence above.",
    "Do not call WebSearch or WebFetch again unless you identify a specific missing fact.",
    "</research_checkpoint>",
  ].join("\n")
}

export function buildResearchCheckpointInjection(
  rootDir: string,
  sessionId: string,
  profileId: string,
  userText: string,
): string | null {
  const checkpoint = readResearchCheckpoint(rootDir, sessionId)
  if (!shouldInjectResearchCheckpoint(userText, checkpoint)) return null
  const sources = readSessionSources(rootDir, sessionId, profileId)
  return formatResearchCheckpointPromptBlock(checkpoint!, sources)
}

export function formatAbortedResearchUserMessage(checkpoint: ResearchCheckpointFile): string {
  const completed = checkpoint.completedItems ?? []
  if (completed.length > 0) {
    const doneList = completed.map(item => item.content).slice(0, 3).join("; ")
    const failed = checkpoint.failedItemLabel
      ? ` Me quedé sin tiempo en: ${checkpoint.failedItemLabel}.`
      : " Me quedé sin tiempo antes del reporte final."
    return [
      `Completé ${completed.length} ítem(s) de la lista (${doneList}).${failed}`,
      "La evidencia de lo hecho quedó guardada.",
      'Decime "seguí" o "contame con lo que buscaste" para sintetizar el resto sin re-buscar.',
    ].join(" ")
  }

  const toolList = checkpoint.toolsRun.join(", ") || "herramientas de investigación"
  const indexPreview = checkpoint.evidenceIndex
    .slice(0, 3)
    .map(e => e.summary)
    .join("; ")
  const preview = indexPreview ? ` (${indexPreview})` : ""
  return [
    `No alcancé a escribir el reporte final (${checkpoint.reason === "max_duration" ? "timeout" : "turno abortado"}),`,
    `pero ya investigué con ${toolList}${preview}.`,
    "La evidencia quedó guardada.",
    'Decime "seguí", "reintentá" o "contame con lo que buscaste" y lo sintetizo sin volver a buscar.',
  ].join(" ")
}

export function mergeResearchCheckpointOnAbort(args: {
  rootDir: string
  sessionId: string
  profileId: string
  userRequest: string
  reason: ResearchCheckpointFile["reason"]
  turnStartedAtMs: number
  steps: AssistantTurnStep[] | undefined
  failedItemLabel?: string
}): ResearchCheckpointFile | null {
  const hasResearch = hasResearchToolSteps(args.steps)
  const existing = readResearchCheckpoint(args.rootDir, args.sessionId)
  if (!hasResearch && !existing?.completedItems?.length) return null

  const checkpoint = saveResearchCheckpointFromTurn({
    rootDir: args.rootDir,
    sessionId: args.sessionId,
    profileId: args.profileId,
    userRequest: args.userRequest,
    reason: args.reason,
    turnStartedAtMs: args.turnStartedAtMs,
    steps: args.steps,
  })

  if (!checkpoint && existing) {
    writeResearchCheckpoint(args.rootDir, args.sessionId, {
      ...existing,
      reason: args.reason,
      failedItemLabel: args.failedItemLabel ?? existing.failedItemLabel,
      consumed: false,
    })
    return readResearchCheckpoint(args.rootDir, args.sessionId)
  }

  if (checkpoint && args.failedItemLabel) {
    writeResearchCheckpoint(args.rootDir, args.sessionId, {
      ...checkpoint,
      failedItemLabel: args.failedItemLabel,
    })
    return { ...checkpoint, failedItemLabel: args.failedItemLabel }
  }

  return checkpoint
}
