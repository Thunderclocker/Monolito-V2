// -----------------------------------------------------------------------------
// Top-level Ralph Gate
//
// Stop-hook analog for the main (orchestrator) session: when the model tries
// to close a turn with unfinished TodoWrite items still in active_tasks.json
// `active_tasks` file, this gate re-feeds a structured retry prompt so the
// model either completes, restructures, or returns TASK_FAILED:<reason>.
//
// Bug history: the top-level path previously delivered the reply without
// checking the task list. The sub-agent path already had the equivalent
// check (buildRalphLoopUnfinishedTasksPrompt inside the orchestrator's
// executeTurn). The sub-agent feature has since been removed; this file
// keeps the surviving top-level gate and its prompt builder.
//
// Implementation note: this file is pure (modulo optional file reads via store);
// safe to unit-test. The caller owns the loop, worklog appends, and re-feed.
// -----------------------------------------------------------------------------

import { wrapAuditFeedback } from "./auditFeedback.ts"
import { listSessionTasks } from "../session/store.ts"
import { readWebSearchConfigAt } from "../websearch/config.ts"

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

export function isSecurityAuditRequest(text: string): boolean {
  if (!text) return false
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()

  const pcSecurity =
    /\b(que tan segura|how secure|seguridad de mi pc|seguridad de la pc|seguridad de mi maquina|seguridad del sistema|audit(a|ar|ame)?\s+(mi\s+)?(pc|maquina|sistema|equipo)|auditoria\s+(de\s+)?(seguridad|sistema|pc|red)|revisa(r)?\s+(la\s+)?seguridad)\b/.test(normalized)
  const hasPcContext = /\b(pc|maquina|equipo|sistema|servidor local|mi compu)\b/.test(normalized)
  return pcSecurity || (hasPcContext && /\b(segura|seguro|seguridad|puertos|firewall|ufw|vulnerab)\b/.test(normalized))
}

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

const WEB_SEARCH_TOOLS = new Set(["Web", "WebSearch", "WebFetch", "ImageSearch"])

export function isLiveWebDataRequest(text: string): boolean {
  if (!text) return false
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  return /\b(clima|weather|pronostico|forecast|tiempo|noticias|news|precio|cotizacion|buscar|search|pronostico del tiempo|como esta el tiempo)\b/.test(normalized)
}

function ranWebSearchTool(turnSteps: Array<{ type?: string; tool?: string }>): boolean {
  return turnSteps.some(s => s.type === "tool" && typeof s.tool === "string" && WEB_SEARCH_TOOLS.has(s.tool))
}

function configuredWebSearchThisTurn(turnSteps: Array<{ type?: string; tool?: string }>): boolean {
  return turnSteps.some(s => s.type === "tool" && s.tool === "tool_manage_config")
}

function isWebSearchReady(rootDir: string): boolean {
  return readWebSearchConfigAt(rootDir).provider !== "default"
}

function userProvidedApiKeyHint(text: string): boolean {
  return /\b(api\s*key|la\s+api|api\s+es|brave|tvly-)\b/i.test(text)
    || /\bBSA[A-Za-z0-9_-]{18,}\b/.test(text)
    || /\btvly-[A-Za-z0-9_-]{10,}\b/i.test(text)
}


/**
 * Evaluate the top-level Ralph gate for a session. Pure function (modulo
 * optional file reads via store); safe to unit-test. The caller is responsible for the
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
  /** Task ids that were pending/in_progress when the user turn started.
   *  Ralph only blocks on these — not on TodoWrite items the agent creates
   *  mid-turn (which caused 3-minute loops on simple clarifying questions). */
  preExistingTaskIds?: Set<string>,
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

  // Rule 3: Security / PC audit — must run tools before answering
  const ranAuditTool = turnSteps.some(
    s => s.type === "tool" && (s.tool === "Bash" || s.tool === "system_status" || s.tool === "SystemStatus"),
  )
  if (isSecurityAuditRequest(lastUserText) && !ranAuditTool) {
    const feedbackPrompt = wrapAuditFeedback(
      `[Ralph Loop] ALERTA DE COMPORTAMIENTO\n` +
      `El usuario pidió una auditoría o evaluación de seguridad de su PC/sistema ("${lastUserText}").\n` +
      `Por regla del sistema debes ejecutar herramientas (Bash: ss -tulnp, ufw status, apt list --upgradable, etc.; o system_status) ANTES de responder.\n` +
      `No preguntes si quiere auditar — auditá directamente con evidencia.\n` +
      `Corrige esto: ejecuta las herramientas de diagnóstico ahora y responde con los resultados.`
    )
    return {
      blocked: true,
      shouldRetry: true,
      feedbackPrompt,
      unfinished: [{ content: "Auditar seguridad del sistema con Bash/system_status", status: "pending" }],
    }
  }

  // Rule 4: Live web data (weather, news, etc.) with search configured — must call Web
  if (isLiveWebDataRequest(lastUserText) && isWebSearchReady(rootDir) && !ranWebSearchTool(turnSteps)) {
    const feedbackPrompt = wrapAuditFeedback(
      `[Ralph Loop] ALERTA DE COMPORTAMIENTO\n` +
      `El usuario pidió información en vivo (clima, noticias, precios, etc.) y CONF_WEBSEARCH ya está configurado.\n` +
      `Debés llamar Web (action=search) con una consulta concreta ANTES de responder.\n` +
      `No des instrucciones manuales de configuración ni repitas API keys.`
    )
    return {
      blocked: true,
      shouldRetry: true,
      feedbackPrompt,
      unfinished: [{ content: "Consultar Web action=search para el pedido del usuario", status: "pending" }],
    }
  }

  // Rule 5: Saved CONF_WEBSEARCH this turn but did not run Web for a pending live-data request
  const priorLiveRequest = isLiveWebDataRequest(lastUserText) || userProvidedApiKeyHint(lastUserText)
  if (priorLiveRequest && configuredWebSearchThisTurn(turnSteps) && isWebSearchReady(rootDir) && !ranWebSearchTool(turnSteps)) {
    const feedbackPrompt = wrapAuditFeedback(
      `[Ralph Loop] ALERTA DE COMPORTAMIENTO\n` +
      `Guardaste CONF_WEBSEARCH en este turno pero no llamaste Web para cumplir el pedido original.\n` +
      `Ejecutá Web (action=search) ahora con la ubicación/consulta del usuario y respondé con los resultados.\n` +
      `Nunca repitas la API key en texto al usuario.`
    )
    return {
      blocked: true,
      shouldRetry: true,
      feedbackPrompt,
      unfinished: [{ content: "Llamar Web action=search tras configurar búsqueda web", status: "pending" }],
    }
  }

  // If the assistant declared TASK_FAILED, do not block the gate.
  if (assistantReply && assistantReply.includes("TASK_FAILED")) {
    return { blocked: false, shouldRetry: false, feedbackPrompt: null, unfinished: [] }
  }

  const tasks = listSessionTasks(rootDir, sessionId, profileId)
  let unfinished = tasks
    .filter(t => (t.status === "pending" || t.status === "in_progress") && t.category !== "life")
  if (preExistingTaskIds !== undefined) {
    unfinished = unfinished.filter(t => preExistingTaskIds.has(t.id))
  }
  const unfinishedSummary = unfinished.map(t => ({ content: t.content, status: t.status }))

  if (unfinishedSummary.length === 0) {
    return { blocked: false, shouldRetry: false, feedbackPrompt: null, unfinished: [] }
  }

  const feedbackPrompt = buildRalphLoopUnfinishedTasksPrompt(
    lastUserText,
    unfinishedSummary,
    assistantReply,
    history,
    attempt,
    TOP_LEVEL_RALPH_ESCAPE_AT,
  )
  return { blocked: true, shouldRetry: true, feedbackPrompt, unfinished: unfinishedSummary }
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
