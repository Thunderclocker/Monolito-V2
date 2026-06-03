import { appendWorklog } from "../session/store.ts"

export type IntegrityViolationType = "none" | "broken_promise" | "falsified_execution"

export interface IntegrityCheckResult {
  verified: boolean
  type: IntegrityViolationType
  reason?: string
}

/**
 * Semantically audits a turn to ensure the assistant does not make promises of future
 * background/deferred action without scheduling them, and does not claim to have executed
 * system commands/files in this turn without actually running them.
 */
export async function checkTurnIntegrity(
  rootDir: string,
  modelText: string,
  toolsCalledInTurn: string[],
  runBackgroundTextTask: (
    rootDir: string,
    system: string,
    userPrompt: string,
    options?: { model?: string; maxTokens?: number }
  ) => Promise<{ text: string }>
): Promise<IntegrityCheckResult> {
  // 1. Trivial check: If the text is very short, no claims or promises could have been made.
  if (!modelText || modelText.trim().length < 10) {
    return { verified: true, type: "none" }
  }

  // 2. Ask a fast LLM to semantically judge if the assistant claims system execution
  // or makes future/deferred promises, comparing them with actual tools called.
  const systemPrompt = `You are a silent runtime auditor. Your task is to analyze if the assistant's proposed response has any of the following tool-use mismatches:

1. "hasBrokenPromise": Did the assistant make a verbal promise to the user for a FUTURE/DEFERRED action (e.g., "te aviso en 5 min", "lo reviso luego", "I will run this in the background", "I'll let you know") that would require a deferred/background tool (e.g. schedule_task, delegate_background_task, background_task) to be called now?
   - CRITICAL: If the assistant is doing the action IMMEDIATELY in this turn (e.g. "I will fix it now" coupled with actual file edits or commands executed this turn), this is NOT a future promise. Only flag promises of LATER/DEFERRED actions.

2. "hasFalsifiedExecution": Did the assistant claim or strongly imply that it has executed system commands, run scripts, performed file/directory creation/modification, or transferred/downloaded data in the current turn?
   - Mismatch check: Does it claim this execution but did not call any corresponding tool (or no tools at all)?

Compare the assistant's claims with the list of tools actually executed in this turn.

Respond strictly in JSON format:
{
  "hasBrokenPromise": boolean,
  "hasFalsifiedExecution": boolean,
  "reason": "brief explanation in English of the mismatch, or empty if none"
}`;

  const userPrompt = `Assistant proposed response: "${modelText}"
Tools executed in this turn: [${toolsCalledInTurn.join(", ")}]`;

  try {
    const { text } = await runBackgroundTextTask(rootDir, systemPrompt, userPrompt, {
      maxTokens: 120,
    })

    const parsed = JSON.parse(text.trim()) as {
      hasBrokenPromise: boolean
      hasFalsifiedExecution: boolean
      reason?: string
    }

    if (parsed.hasFalsifiedExecution === true) {
      return {
        verified: false,
        type: "falsified_execution",
        reason: parsed.reason || "Assistant claims execution without invoking corresponding tools",
      }
    }

    if (parsed.hasBrokenPromise === true) {
      return {
        verified: false,
        type: "broken_promise",
        reason: parsed.reason || "Assistant made a future promise but did not schedule or delegate a background task",
      }
    }
  } catch (error) {
    // Fail-safe: if the validation model fails or errors out, let it pass to ensure execution continuity.
    return { verified: true, type: "none" }
  }

  return { verified: true, type: "none" }
}

/**
 * Logs a veracity guard breach to the session worklog.
 */
export function logVeracityBreach(rootDir: string, sessionId: string, reason: string, text: string) {
  appendWorklog(rootDir, sessionId, {
    type: "note",
    summary: `VERACITY_GUARD_REJECTED: "${reason}" | Original: "${text.slice(0, 80)}..."`,
  })
}

/**
 * Logs a broken commitment to the session worklog.
 */
export function logBrokenPromise(rootDir: string, sessionId: string, reason: string, text: string) {
  const preview = text.length > 100 ? text.slice(0, 100) + "..." : text
  appendWorklog(rootDir, sessionId, {
    type: "note",
    summary: `BROKEN_PROMISE BROKEN reason="${reason}" text="${preview}"`,
  })
}
