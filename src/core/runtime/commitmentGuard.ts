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

/** True if the given tool name is a background/deferred work tool. */
function isBackgroundTool(toolName: string): boolean {
  return (BACKGROUND_TOOL_NAMES as readonly string[]).includes(toolName)
}

/**
 * Detects if text contains language that might indicate a commitment to future action.
 * Used as a fast, multilingual pre-filter before calling the heavier semantic LLM.
 */
export function hasCommitmentKeywords(text: string): boolean {
  const MULTILINGUAL_PRE_FILTER = /\b(aviso|avisaré|avisare|recuerdo|recordaré|recordare|reviso|revisaré|revisare|chequeo|chequearé|chequeare|analizo|analizaré|analizare|verifico|verificaré|verificare|confirmo|confirmaré|confirmare|mando|mandaré|mandare|envio|envío|enviaré|enviare|ocupo|encargo|pendiente|mañana|manana|luego|rato|remind|later|tomorrow|background|bg|notify|inform|warn|ping|check|review|inspect|analyse|analyze|verify|promise|commit|left|pending|soon|shortly|moment|minute|hour|day|week)\b/i;
  return MULTILINGUAL_PRE_FILTER.test(text);
}

/**
 * Semantically audits a turn for broken commitments using a cheap LLM call.
 * This is language-independent and highly accurate.
 */
export async function checkTurnCommitmentSemantic(
  rootDir: string,
  modelText: string,
  toolsCalledInTurn: string[],
  runBackgroundTextTask: (
    rootDir: string,
    system: string,
    userPrompt: string,
    options?: { model?: string; maxTokens?: number }
  ) => Promise<{ text: string }>
): Promise<CommitmentCheckResult> {
  const backgroundFlags = toolsCalledInTurn.map(isBackgroundTool)
  const hasBackgroundTool = backgroundFlags.some(Boolean)

  // 1. Trivial check: If the text is very short, or we already called a background tool (promise fulfilled), we are done.
  if (!modelText || modelText.trim().length < 10) {
    return {
      hasCommitmentLanguage: false,
      detectedPattern: null,
      toolsCalled: toolsCalledInTurn,
      isBackgroundTool: backgroundFlags,
      isBrokenPromise: false,
      severity: "none",
    }
  }

  if (hasBackgroundTool) {
    return {
      hasCommitmentLanguage: true,
      detectedPattern: "semantic_fulfilled",
      toolsCalled: toolsCalledInTurn,
      isBackgroundTool: backgroundFlags,
      isBrokenPromise: false,
      severity: "none",
    }
  }

  // 2. Multilingual keyword pre-filter to avoid LLM calls on plain statements.
  // Bypassed if toolsCalledInTurn is empty to ensure complete semantic accuracy without hardcoded slang keywords.
  if (toolsCalledInTurn.length > 0 && !hasCommitmentKeywords(modelText)) {
    return {
      hasCommitmentLanguage: false,
      detectedPattern: null,
      toolsCalled: toolsCalledInTurn,
      isBackgroundTool: backgroundFlags,
      isBrokenPromise: false,
      severity: "none",
    }
  }

  // 3. Ask a fast LLM to semantically judge the commitment.
  const systemPrompt = `You are a silent runtime auditor. Analyze if the assistant made a verbal promise to the user for a FUTURE action (e.g., "I will remind you", "te aviso en 5 min", "lo reviso más tarde", "I will run this in the background", "I'll let you know") that would require a deferred/background tool to be executed now.
  
  CRITICAL: If the assistant is doing the action IMMEDIATELY in this turn (e.g. "I will fix it now" coupled with actual file edits or commands executed this turn), this is NOT a future promise. Only flag promises of LATER/DEFERRED actions.

  Respond strictly in JSON format:
  {
    "hasFuturePromise": boolean,
    "reason": "brief explanation in English"
  }`;

  const userPrompt = `Assistant message: "${modelText}"\nTools executed: [${toolsCalledInTurn.join(", ")}]`;

  try {
    const { text } = await runBackgroundTextTask(rootDir, systemPrompt, userPrompt, {
      maxTokens: 100,
    });

    const parsed = JSON.parse(text.trim());
    if (parsed.hasFuturePromise === true) {
      return {
        hasCommitmentLanguage: true,
        detectedPattern: "semantic_llm",
        toolsCalled: toolsCalledInTurn,
        isBackgroundTool: backgroundFlags,
        isBrokenPromise: true,
        severity: "broken",
      };
    }
  } catch (error) {
    // Fail silently to ensure the runtime is never interrupted
  }

  return {
    hasCommitmentLanguage: false,
    detectedPattern: null,
    toolsCalled: toolsCalledInTurn,
    isBackgroundTool: backgroundFlags,
    isBrokenPromise: false,
    severity: "none",
  };
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