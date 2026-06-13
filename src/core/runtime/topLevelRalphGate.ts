// -----------------------------------------------------------------------------
// Top-level Ralph Gate
//
// Stop-hook analog for the main (orchestrator) session: when the model tries
// to close a turn with unfinished TodoWrite items still in the Memory Palace
// `active_tasks` wing, this gate re-feeds a structured retry prompt so the
// model either completes, restructures, or returns TASK_FAILED:<reason>.
//
// Bug history: the top-level path previously delivered the reply without
// checking the task list. The sub-agent path already had the equivalent
// check (buildRalphLoopUnfinishedTasksPrompt inside the orchestrator's
// executeTurn). The sub-agent feature has since been removed; this file
// keeps the surviving top-level gate and its prompt builder.
//
// Implementation note: this file is pure (modulo a SQLite read via
// listSessionTasks). The runtime owns the loop, the worklog appends, and
// the actual re-feed via appendMessage + re-running the agent loop.
// -----------------------------------------------------------------------------

import { wrapAuditFeedback } from "./auditFeedback.ts"
import { listSessionTasks } from "../session/store.ts"

export type TopLevelRalphGateResult = {
  /** True when the gate has unfinished items and the loop must continue. */
  blocked: boolean
  /** Convenience alias matching the runtime loop's vocabulary. */
  shouldRetry: boolean
  /** Feedback prompt to re-feed as a user message. Null when clean. */
  feedbackPrompt: string | null
  /** The unfinished items that triggered the block. */
  unfinished: Array<{ content: string; status: string }>
}

export const TOP_LEVEL_RALPH_MAX_ATTEMPTS = 20
export const TOP_LEVEL_RALPH_ESCAPE_AT = 15

export function isScreenViewingRequest(text: string): boolean {
  if (!text) return false
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  
  // 1. "what do you see" / "que ves" / "que se ve" / "que estas viendo" / "que hay"
  const whatDoYouSee = /\b(que ves|que se ve|que estas viendo|what (?:do you|can you|doyou|canyou) see|what(?:'s| is) on|que hay)\b/.test(normalized)
  
  // 2. Look/see/show/describe/analyze/take/capture combined with screen/screenshot/display/desktop/escritorio/tela/ecran/schermo/captura/pantallazo/imagen/bureau
  const lookAtScreen = /\b(pantalla|screen|display|desktop|escritorio|screenshot|captura|pantallazo|imagen|tela|ecran|schermo|cattura|bildschirm)\b/.test(normalized) && 
                       /\b(mira|ver|analiz|describ|mostr|verific|look|see|show|describ|analyz|watch|view|what|que|whats|check|saca|toma|hace|haz|take|capture|make|voir|regarder|olhar|guardare|vedere)\b/.test(normalized)
  
  // 3. Direct screenshot/capture requests
  const directScreenshot = /\b(screenshot|pantallazo|captura de pantalla|captura de escritorio|screen capture|screen grab)\b/.test(normalized)

  return whatDoYouSee || lookAtScreen || directScreenshot
}


/**
 * Evaluate the top-level Ralph gate for a session. Pure function (modulo
 * the SQLite read); safe to unit-test. The caller is responsible for the
 * loop, the worklog appends, and the actual re-feed via appendMessage +
 * re-running the agent loop.
 */
export function evaluateTopLevelRalphGate(
  rootDir: string,
  sessionId: string,
  profileId: string,
  lastUserText: string,
  attempt: number,
  assistantReply: string,
  history: Array<{ attempt: number; kind: string; summary: string }> = [],
  turnSteps: any[] = [],
): TopLevelRalphGateResult {
  const hasAttachedScreenshot = lastUserText.includes('kind="photo"') || lastUserText.includes('attachment kind="photo"')
  const tookScreenshot = turnSteps.some(s => s.type === "tool" && s.tool === "CaptureScreenshot") || hasAttachedScreenshot
  const analyzedScreenshot = turnSteps.some(s => s.type === "tool" && s.tool === "VisionAnalyze")

  // Rule 1: User requested to see/analyze screen but no screenshot was taken
  if (isScreenViewingRequest(lastUserText) && !tookScreenshot) {
    const feedbackPrompt = wrapAuditFeedback(
      `[Ralph Loop] ALERTA DE COMPORTAMIENTO\n` +
      `El usuario ha preguntado qué ves en su pantalla o te ha pedido mirar/analizar su pantalla ("${lastUserText}").\n` +
      `Por regla del sistema, debes tomar obligatoriamente una captura de pantalla usando la herramienta CaptureScreenshot en este turno.\n` +
      `Corrige esto: ejecuta la herramienta CaptureScreenshot inmediatamente.`
    )
    return {
      blocked: true,
      shouldRetry: true,
      feedbackPrompt,
      unfinished: [{ content: "Tomar una captura de pantalla con CaptureScreenshot", status: "pending" }],
    }
  }

  // Rule 2: Screenshot was taken in this turn, but not analyzed.
  // Pre-attached screenshots are visible natively to multimodal models.
  const capturedInTurn = turnSteps.some(s => s.type === "tool" && s.tool === "CaptureScreenshot")
  if (capturedInTurn && !analyzedScreenshot) {
    const feedbackPrompt = wrapAuditFeedback(
      `[Ralph Loop] ALERTA DE COMPORTAMIENTO\n` +
      `Se dispone de una captura de pantalla local (ya sea porque la ejecutaste o porque viene adjunta en el mensaje), pero NO la has analizado con la herramienta VisionAnalyze.\n` +
      `Por regla del sistema, toda captura de pantalla local debe ser analizada inmediatamente usando VisionAnalyze pasando el 'path' de la captura para poder responder al usuario qué es lo que se ve en su pantalla.\n` +
      `Corrige esto: ejecuta VisionAnalyze en el path de la captura de pantalla obtenida/adjunta y responde con el análisis.`
    )
    return {
      blocked: true,
      shouldRetry: true,
      feedbackPrompt,
      unfinished: [{ content: "Analizar la captura de pantalla con VisionAnalyze", status: "pending" }],
    }
  }

  // If the assistant declared TASK_FAILED, do not block the gate.
  if (assistantReply && assistantReply.includes("TASK_FAILED")) {
    return { blocked: false, shouldRetry: false, feedbackPrompt: null, unfinished: [] }
  }

  const tasks = listSessionTasks(rootDir, sessionId, profileId)
  const unfinished = tasks
    .filter(t => (t.status === "pending" || t.status === "in_progress") && t.category !== "life")
    .map(t => ({ content: t.content, status: t.status }))

  if (unfinished.length === 0) {
    return { blocked: false, shouldRetry: false, feedbackPrompt: null, unfinished: [] }
  }

  const feedbackPrompt = buildRalphLoopUnfinishedTasksPrompt(
    lastUserText,
    unfinished,
    assistantReply,
    history,
    attempt,
    TOP_LEVEL_RALPH_ESCAPE_AT,
  )
  return { blocked: true, shouldRetry: true, feedbackPrompt, unfinished }
}

/**
 * Build the feedback prompt for the top-level Ralph Loop. Reuses the
 * "attempt history", "tool anchors", and "escape hatch" sections that
 * the sub-agent path used to use, but framed for the main session
 * (no "sub-agent" wording).
 *
 * The body is routed through wrapAuditFeedback so the model gets
 * explicit demarcation and a "respond naturally" reminder, instead
 * of a plain user-rol message that reads like orchestration notes.
 */
export function buildRalphLoopUnfinishedTasksPrompt(
  task: string,
  unfinished: Array<{ content: string; status: string }>,
  assistantReply: string,
  history: Array<{ attempt: number; kind: string; summary: string }>,
  attempt: number,
  escapeAt: number,
  toolAnchors: Array<{ tool: string; brief: string }> = [],
): string {
  const listStr = unfinished.map(t => `- [${t.status.toUpperCase()}] ${t.content}`).join("\n")
  const body = [
    `Tareas en tu lista que quedaron abiertas:`,
    listStr,
    "",
    "Para cerrar:",
    "1. Si podés completar las tareas pendientes, hacelo y marcalas con TodoWrite.",
    "2. Si el breakdown estaba mal, corregilo con TodoWrite.",
    "3. Si no podés, emití TASK_FAILED:<razón>.",
    "",
    "No marques tasks como completed sin haberlas hecho.",
    "",
    buildAttemptHistorySection(history),
    buildToolAnchorSection(toolAnchors),
    buildEscapeHatchSection(attempt, escapeAt, history),
    `Última respuesta rechazada (no repitas el mismo contenido):`,
    clip(assistantReply, 500),
  ].filter(Boolean).join("\n")
  return wrapAuditFeedback(body)
}

// -----------------------------------------------------------------------------
// Prompt-section helpers
// -----------------------------------------------------------------------------

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function clip(value: string, max = 500) {
  const normalized = compactWhitespace(value)
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`
}

function buildAttemptHistorySection(history: Array<{ attempt: number; kind: string; summary: string }>): string {
  if (history.length === 0) return ""
  const recent = history.slice(-3)
  return [
    "## PRIOR ATTEMPTS (do NOT repeat these approaches)",
    recent.map(h => `- [attempt ${h.attempt}] [${h.kind}] ${clip(h.summary, 200)}`).join("\n"),
    "",
  ].join("\n")
}

/**
 * React to results of the model's previous attempt: tell it which tools
 * already produced output it can build on, and which inputs to avoid
 * re-issuing verbatim. This is the "reactive" part of the Ralph Loop:
 * iteration N+1 should not blindly retry iteration N's tool calls —
 * it should reuse what worked and skip what didn't.
 */
function buildToolAnchorSection(anchors: Array<{ tool: string; brief: string }>): string {
  if (anchors.length === 0) return ""
  // Deduplicate identical (tool, brief) pairs to keep the prompt lean.
  const seen = new Set<string>()
  const unique: Array<{ tool: string; brief: string }> = []
  for (const a of anchors) {
    const key = `${a.tool}::${a.brief}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(a)
  }
  return [
    "## TOOL ANCHORS — work already attempted in this task",
    "These tools have been called in prior attempts. Do NOT re-issue identical inputs — either reuse the output, refine the input, or pick a different tool.",
    unique.map(a => `- ${a.tool}: ${a.brief}`).join("\n"),
    "",
  ].join("\n")
}

function buildEscapeHatchSection(attempt: number, escapeAt: number, history: Array<{ attempt: number; kind: string; summary: string }>): string {
  if (attempt < escapeAt) return ""
  const remaining = 20 - attempt
  const recent = history.slice(-5)
  return [
    `## ESCAPE HATCH (attempt ${attempt}/20, ${remaining} remaining)`,
    "You have iterated many times. Before the next attempt, you MUST surface the blocker with structure:",
    "1. WHAT YOU TRIED — list the approaches you actually attempted (not just rejected attempts)",
    "2. WHAT FAILED — for each, the specific failure mode (exit code, error message, missing data)",
    "3. WHAT YOU NEED — is it a tool you don't have? a permission? information only the user has? a structural issue in the codebase?",
    "4. WHY YOU CAN'T PROCEED — be honest. 'The task is impossible as specified' is a valid answer if it's true.",
    "",
    "You will have one more attempt after this. Make it count by either:",
    "(a) trying a fundamentally different approach informed by the above, OR",
    "(b) returning a structured failure with the data above so the runtime can surface it to the user.",
    "",
    "Recent attempts:",
    recent.map(h => `- [${h.attempt}] ${h.kind}: ${clip(h.summary, 150)}`).join("\n"),
    "",
  ].join("\n")
}
