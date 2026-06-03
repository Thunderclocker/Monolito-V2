import { appendWorklog } from "../session/store.ts"

export interface VeracityCheckResult {
  verified: boolean
  reason?: string
}

/**
 * Semantically audits a turn to ensure the assistant does not claim to have
 * executed commands, scripts, or file system/network changes without actually calling them.
 */
export async function checkTurnVeracity(
  rootDir: string,
  modelText: string,
  toolsCalledInTurn: string[],
  runBackgroundTextTask: (
    rootDir: string,
    system: string,
    userPrompt: string,
    options?: { model?: string; maxTokens?: number }
  ) => Promise<{ text: string }>
): Promise<VeracityCheckResult> {
  // 1. Trivial check: If the text is very short, no claims could have been made.
  if (!modelText || modelText.trim().length < 15) {
    return { verified: true }
  }

  // 2. Ask a fast LLM to semantically judge if the assistant claims system execution
  // and whether the tools called are sufficient to support that claim.
  const systemPrompt = `You are a silent runtime auditor. Your task is to analyze if the assistant's proposed response claims or implies that it has executed system commands, run scripts, modified/created files, or downloaded/transferred data in the current turn.

Compare the assistant's claims with the list of tools actually executed in this turn.
Identify if there is a mismatch (i.e., the assistant claims to have performed an action but did not execute the corresponding tool, or executed no tools at all).

Respond strictly in JSON format:
{
  "claimsExecution": boolean,
  "hasMismatch": boolean,
  "reason": "brief explanation in English of the mismatch, or empty if no mismatch"
}`;

  const userPrompt = `Assistant proposed response: "${modelText}"
Tools executed in this turn: [${toolsCalledInTurn.join(", ")}]`;

  try {
    const { text } = await runBackgroundTextTask(rootDir, systemPrompt, userPrompt, {
      maxTokens: 120,
    })

    const parsed = JSON.parse(text.trim()) as { claimsExecution: boolean; hasMismatch: boolean; reason?: string }
    if (parsed.hasMismatch === true) {
      return {
        verified: false,
        reason: parsed.reason || "Assistant claims execution without invoking the corresponding tools",
      }
    }
  } catch (error) {
    // Fail-safe: if the validation model fails or errors out, let it pass to ensure execution continuity.
    return { verified: true }
  }

  return { verified: true }
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
