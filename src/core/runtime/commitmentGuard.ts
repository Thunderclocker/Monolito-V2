/**
 * ToolCommitmentGuard
 *
 * Detects when the model makes verbal commitments (promises of future action)
 * without calling the appropriate tools to fulfill them.
 *
 * == How it works ==
 *
 * Every turn, after the model generates text and executes tools, we check:
 * 1. Does the text contain language that commits to a future action?
 *    (e.g. "te aviso en 5 minutos", "lo reviso en segundo plano")
 * 2. If yes, what tools were called this turn?
 * 3. Did the model call a tool that actually fulfills that commitment?
 *
 * == Severity levels ==
 *
 * - "none":    No commitment language detected. Nothing to check.
 * - "broken":  Commitment detected, but no background-oriented tool was called,
 *              or no tools at all. The promise was not fulfilled.
 * - "suspicious": Commitment detected AND a background-oriented tool was called,
 *                 but the promise pattern and the tool used seem mismatched or
 *                 the promise is still suspicious (e.g. the model says it's
 *                 "analyzing in background" but the tool call might not align well).
 *                 In practice: this means the model used schedule_task or
 *                 delegate_background_task, so the commitment was technically
 *                 fulfilled, but we log it for audit purposes.
 *
 * == Background tools ==
 *
 * These are the tools that create deferred/long-running work. When the model
 * promises something that sounds like background work, it should call one of these.
 *
 * To extend this list:
 *   1. Add the tool name to BACKGROUND_TOOL_NAMES below.
 *   2. If the tool is truly a "background/delegate" type, it should also be
 *      considered a valid fulfillment of background promises.
 *   3. Tools that do immediate work (Bash, WebSearch, etc.) are NOT here
 *      because they represent synchronous execution, not deferred promises.
 *
 * == Limitations ==
 *
 * - Pattern matching is heuristic and language-specific (Spanish).
 *   Will need updates as the model evolves or if multi-language support is added.
 * - No semantic matching: we don't check if the tool called actually fulfills
 *   the specific promise made. We only check that a "background" tool was called.
 *   Example: model promises "te mando el archivo" but calls schedule_task
 *   (a reminder, not a file sender) → marked as suspicious even though technically
 *   a background tool was used.
 * - severity="suspicious" is logged but not acted upon. Future work could
 *   add re-prompt or correction logic for suspicious cases.
 */

import { appendWorklog } from "../session/store.ts"

/** Tools that create deferred / background work. */
export const BACKGROUND_TOOL_NAMES = [
  "delegate_background_task",
  "schedule_task",
  "background_task",
] as const

export type BackgroundToolName = typeof BACKGROUND_TOOL_NAMES[number]

/**
 * Result of checking a single turn for broken promises.
 */
export interface CommitmentCheckResult {
  /** True if the model's text contained commitment language. */
  hasCommitmentLanguage: boolean
  /** The pattern label that matched (e.g. "aviso_diferido", "background_task"). */
  detectedPattern: string | null
  /** Tool names called in this turn (empty if none). */
  toolsCalled: string[]
  /** Per-tool: true if that tool is in BACKGROUND_TOOL_NAMES. */
  isBackgroundTool: boolean[]
  /** True if this is definitively a broken promise (no fulfillment attempted). */
  isBrokenPromise: boolean
  /**
   * Severity of the situation:
   * - "none":       No commitment detected, nothing to do.
   * - "broken":     Commitment detected, no background tool called → broken.
   * - "suspicious": Commitment detected and a background tool was called,
   *                 but the match is not clean enough to call it resolved.
   */
  severity: "none" | "suspicious" | "broken"
}

interface CommitmentPattern {
  pattern: RegExp
  /** Short identifier for logging. */
  label: string
  /** Example phrases that would match. */
  examples: string[]
}

/**
 * Patterns that indicate the model is promising future action.
 * Ordered roughly by how explicitly they imply deferred work.
 */
const COMMITMENT_PATTERNS: CommitmentPattern[] = [
  {
    pattern: /te aviso (en|cuando|dentro|mas tarde|más tarde| después)/i,
    label: "aviso_diferido",
    examples: ["te aviso en 5 minutos", "te aviso cuando termine"],
  },
  {
    pattern: /te recuerdo/i,
    label: "recuerdo",
    examples: ["te recuerdo que...", "te lo recuerdo"],
  },
  {
    pattern: /(lo|te) (reviso|chequeo|analizo|verifico|confirmo)/i,
    label: "revision_diferida",
    examples: ["lo reviso después", "te lo mando mañana"],
  },
  {
    pattern: /(lo|se lo) (mando|envio|mandaré|enviaré)/i,
    label: "envio_diferido",
    examples: ["te lo mando luego", "se lo envío en un rato"],
  },
  {
    pattern: /(lo |la |te )?analizo (en|de|por)? ?(segundo plano|background|bg|background task)/i,
    label: "background_task",
    examples: ["lo analizo en segundo plano", "la analizo en bg"],
  },
  {
    pattern: /en (un rato|un momento|unos minutos|breve|cuanto antes)/i,
    label: "tiempo_relativo",
    examples: ["en un rato te aviso", "en breve te informo"],
  },
  {
    pattern: /(mañana|pasado mañana|la semana que viene|el (lunes|martes|miercoles|jueves|viernes|sabado|domingo))/i,
    label: "tiempo_futuro",
    examples: ["mañana te lo mando", "el viernes te aviso"],
  },
  {
    pattern: /(pendiente|queda|lo dejo) (para|antes de) /i,
    label: "tarea_pendiente",
    examples: ["lo dejo para después", "queda pendiente de revisar"],
  },
  {
    pattern: /vas a tener (el resultado|la respuesta|más información)/i,
    label: "promesa_resultado",
    examples: ["vas a tener la respuesta pronto", "vas a tener el resultado"],
  },
  {
    pattern: /(te|se lo|lo) informo (cuando|después|en cuanto)/i,
    label: "informe_diferido",
    examples: ["te informo cuando termine", "lo informo en cuanto esté listo"],
  },
  {
    pattern: /no te preocupes,? (lo|te) /i,
    label: "tranquilizar_con_accion",
    examples: ["no te preocupes, lo resuelvo", "no te preocupes, te aviso"],
  },
  {
    pattern: /(me|me lo) encargo/i,
    label: "encargo",
    examples: ["me encargo de eso", "me lo encargo"],
  },
  {
    pattern: /(te|se lo|de eso) (hago|hago cargo|me ocupo)/i,
    label: "ocupo_accion",
    examples: ["me ocupo de eso", "te lo hago"],
  },
  {
    pattern: /dejámelo a (mí|mi|cargo)/i,
    label: "dejo_a_cargo",
    examples: ["dejámelo a mí", "déjamelo a cargo"],
  },
  {
    pattern: /(te |se )?lo? ?(verifico|reviso|chequeo) (más|también|además)/i,
    label: "verificacion_adicional",
    examples: ["lo verifico también", "reviso más tarde"],
  },
  {
    pattern: /(te |se )?lo? ?(busco|encuentro|obtengo) (después|luego|más tarde)/i,
    label: "busqueda_diferida",
    examples: ["te lo busco después", "lo encuentro luego"],
  },
]

/**
 * Patterns that negate or cancel a commitment.
 * If any of these match, we don't treat the text as a commitment.
 */
const NEGATION_PATTERNS = [
  /ya (te |se |lo )?(avisé|envié|mandé|recordé|revisé|enviado|mandado|revisado|analizado|chequeado)/i,
  /ya está (hecho|listo|enviado|mandado|revisado|hecha|lista)/i,
  /ya te (dije|conté|mandé|envié|avisé|di)/i,
  /no te preocupes, ya/i,
  /ya mismo lo (hago|envío|mando|reviso)/i,
  /acabamos de (ver|revisar|analizar|enviar)/i,
  /acabo de (ver|revisar|analizar|enviar)/i,
  /ya lo tengo(és)?/i,
  /ya está listo/i,
]

/**
 * Detects if text contains language that makes a commitment to future action.
 * Returns { detected: false } for negations, { detected: true, pattern: label } for matches.
 */
export function detectCommitmentLanguage(
  text: string,
): { detected: boolean; pattern: string | null } {
  for (const negation of NEGATION_PATTERNS) {
    if (negation.test(text)) {
      return { detected: false, pattern: null }
    }
  }

  for (const { pattern, label } of COMMITMENT_PATTERNS) {
    if (pattern.test(text)) {
      return { detected: true, pattern: label }
    }
  }

  return { detected: false, pattern: null }
}

/** True if the given tool name is a background/deferred work tool. */
function isBackgroundTool(toolName: string): boolean {
  return (BACKGROUND_TOOL_NAMES as readonly string[]).includes(toolName)
}

/**
 * Checks a single turn for broken promises.
 *
 * @param modelText     - The text generated by the model this turn.
 * @param toolsCalledInTurn - Names of tools executed this turn (may be empty).
 */
export function checkTurnCommitment(
  modelText: string,
  toolsCalledInTurn: string[],
): CommitmentCheckResult {
  const { detected, pattern } = detectCommitmentLanguage(modelText)

  if (!detected) {
    return {
      hasCommitmentLanguage: false,
      detectedPattern: null,
      toolsCalled: toolsCalledInTurn,
      isBackgroundTool: toolsCalledInTurn.map(isBackgroundTool),
      isBrokenPromise: false,
      severity: "none",
    }
  }

  if (toolsCalledInTurn.length === 0) {
    // Commitment made but no tool at all → broken.
    return {
      hasCommitmentLanguage: true,
      detectedPattern: pattern,
      toolsCalled: [],
      isBackgroundTool: [],
      isBrokenPromise: true,
      severity: "broken",
    }
  }

  const backgroundFlags = toolsCalledInTurn.map(isBackgroundTool)
  const hasBackgroundTool = backgroundFlags.some(Boolean)

  if (!hasBackgroundTool) {
    // Commitment made, tools called, but none are background tools → broken.
    // Example: model says "te aviso en 5 min" but called Bash or WebSearch.
    return {
      hasCommitmentLanguage: true,
      detectedPattern: pattern,
      toolsCalled: toolsCalledInTurn,
      isBackgroundTool: backgroundFlags,
      isBrokenPromise: true,
      severity: "broken",
    }
  }

  // Commitment made and a background tool was called → suspicious (fulfilled but logged).
  // This is "suspicious" rather than "ok" because we don't verify semantic alignment
  // between the promise and the actual tool call.
  return {
    hasCommitmentLanguage: true,
    detectedPattern: pattern,
    toolsCalled: toolsCalledInTurn,
    isBackgroundTool: backgroundFlags,
    isBrokenPromise: false,
    severity: "suspicious",
  }
}

/**
 * Logs a broken or suspicious promise to the session worklog.
 * Always uses type="note" to comply with SessionWorklogEntry type constraints.
 */
export function logBrokenPromise(
  rootDir: string,
  sessionId: string,
  result: CommitmentCheckResult,
  modelText: string,
): void {
  const preview =
    modelText.length > 100 ? modelText.slice(0, 100) + "..." : modelText
  const toolsStr =
    result.toolsCalled.length > 0
      ? `tools=[${result.toolsCalled.join(",")}]`
      : "tools=[]"
  const bgCount = result.isBackgroundTool.filter(Boolean).length
  const bgStr = bgCount > 0 ? `bg_tools=${bgCount}` : "bg_tools=0"

  appendWorklog(rootDir, sessionId, {
    type: "note",
    summary:
      `BROKEN_PROMISE ${result.severity.toUpperCase()} ` +
      `pattern="${result.detectedPattern}" ${toolsStr} ${bgStr} ` +
      `text="${preview}"`,
  })
}