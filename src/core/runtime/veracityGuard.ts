import { appendWorklog } from "../session/store.ts"

export type IntegrityViolationType = "none" | "broken_promise" | "falsified_execution" | "unverified_incapacity"

export interface IntegrityCheckResult {
  verified: boolean
  type: IntegrityViolationType
  reason?: string
}

// -----------------------------------------------------------------------------
// Deterministic falsified-execution detection.
//
// Runs BEFORE the LLM auditor so the obvious cases (fabricated tool output,
// first-person past-tense claims of action) are caught without an extra model
// call and without the auditor's fail-open behavior.
//
// Two layers:
//   - STRUCTURAL_OUTPUT: tool outputs are formatted (JSON, units, log tags,
//     tool names) in ways the model can't fake reliably across languages.
//   - FIRST_PERSON_CLAIM: claims of having done something, in any natural
//     language. Verb lists are easy to extend when a new language appears.
// -----------------------------------------------------------------------------

const STRUCTURAL_OUTPUT: RegExp[] = [
  // JSON claiming tool result (any common tool key, single-line or compact)
  /\{[^{}]*"(ok|success|message_id|file_id|result|status|output|stdout|stderr|exit_code)"\s*:/i,
  // Code block containing a JSON tool result
  /```[a-z]*\s*\n?\s*\{[^`]*(ok|message_id|file_id|result)[^`]*\}\s*\n?```/i,
  // Structured key=value or key: value with tool-specific tokens
  /\b(message_id|file_id|duration|file_size|exit_code)\s*[:=]/i,
  // Numeric magnitudes with units (only tools produce these)
  /\b\d+\s*(bytes|KB|MB|GB|ms|s|m|h)\b/i,
  // Boolean/numeric result patterns
  /\b(ok|success|done|completed|failed)\s*[:=]\s*(true|false|null|\d+)\b/i,
  // Log/error tags — these are jargon, not natural language
  /\[(SideEffect|Side-effect|Coherence|Veracity|Ralph)[-_ ]?[A-Za-z]*\]/i,
  // Guard verdict formats
  /\b(BLOCKED|ALLOWED|REJECTED|BYPASS)\b\s+\w+\s*[:=]/i,
  // Unix `ls -la` style listing
  /^[ \t]*(drwx|-rw-|lrwx)[-rwx]{9}\s+\d+\s+\w+\s+\w+\s+\d+\s+\w+\s+\d+\s+[\d:]+\s+\//m,
  // Unified diff header (only patch tools produce this)
  /^---\s+[^\n]+\n\+\+\+\s+[^\n]+\n@@/m,
  // Tool name + args paren (imitating a tool call log line)
  /\b(TelegramSendVoice|GenerateSpeech|TelegramSendPhoto|TelegramSendAudio|Bash|WebFetch|WebSearch|BootWrite|BootRead|Edit|Read)\s*\(\s*\{/i,
  // Bare "ok: true" (very common fabricated result)
  /\bok\s*[:=]\s*true\b/i,
]

const FIRST_PERSON_CLAIM: RegExp[] = [
  // Spanish — pretérito of common action verbs. No trailing \b because
  // JavaScript's \b is ASCII-only and doesn't recognize accented chars as
  // word characters, so `\bprobé\b` would never match.
  /\b(probé|ejecuté|corrí|llamé|hice|usé|intenté|revisé|leí|busqué|generé|envié|mandé|descargué|creé|abrí|cerré|guardé|eliminé)/i,
  // English — I + past tense
  /\b(I\s+(tried|ran|executed|called|made|used|attempted|checked|read|searched|generated|sent|deleted|wrote|created))\b/i,
  // Portuguese — pretérito of common action verbs
  /\b(provei|executei|corri|chamei|fiz|usei|tentei|li|busquei|gerrei|enviei|mandei)\b/i,
  // Passive/reflexive in any of those languages
  /\b(se\s+(ejecutó|corrió|envió|mandó|generó)|fue\s+(ejecutado|enviado|generado))\b/i,
  // First-person future/intent claim: "voy a", "voy con", "I'll", "vou a", "procedo a"
  /\b(voy|procedo|vou|let'?s|I'?ll)(\s+a|\s+\w+)/i,
]

/**
 * Fix B (2026-06-10): negation-of-execution patterns. Catches the
 * model claiming it did NOT execute any tool when in fact the worklog
 * shows tools ran. Example from incident 2026-06-10T20:53:01:
 *   "En este turno no ejecuté ninguna tool — solo te copié el formato"
 * while the worklog had 2 VoiceClone calls in that turn. The TUI showed
 * the user the real tool outputs, but the model contradicted the TUI.
 *
 * These are matched only when `toolsCalledInTurn.length === 0` is FALSE
 * (i.e. there are actual tools in the worklog for this turn). When
 * matched AND tools were called, it's a falsified execution claim.
 */
const FIRST_PERSON_EXECUTION_NEGATION: RegExp[] = [
  // Spanish
  /\bno\s+(ejecut(é|é)|corr(í|i)|llam(é|e)|us(é|e)|hice|invoc(é|ué))(\s+(ninguna|ninguno|ningún|ni\s+una|nada|tool|herramienta))/i,
  /\bno\s+eje?cut(é|é|é)\s+ninguna\b/i,
  /\b(ninguna|ninguno|ningún)\s+(tool|herramienta|funci(ó|o)n)\s+(se\s+)?(ejecut(ó|ó)|llam(ó|o)|corr(ió|io))/i,
  // English
  /\bI\s+did\s+not\s+(execute|run|call|invoke|use)\s+(any\s+)?(tool|function|command)/i,
  /\bno\s+tools?\s+(were|was)\s+(executed|run|called|invoked)/i,
  /\bI\s+(didn'?t|did\s+not)\s+(execute|run|call|invoke|use)\s+(any\s+)?(tool|function|command)/i,
]

/**
 * Deterministic pre-LLM check. Returns a falsified_execution violation if the
 * assistant's text contains structural tool output or a first-person past
 * claim of action while no tools were called this turn.
 */
function deterministicFalsifiedExecutionCheck(
  modelText: string,
  toolsCalledInTurn: string[],
): IntegrityCheckResult {
  if (toolsCalledInTurn.length > 0) {
    // Fix B (2026-06-10): when tools WERE called this turn, the model
    // must not claim the opposite. Catches "I didn't execute any tool"
    // when the TUI / worklog shows N tools ran.
    for (const pattern of FIRST_PERSON_EXECUTION_NEGATION) {
      const match = modelText.match(pattern)
      if (match) {
        return {
          verified: false,
          type: "falsified_execution",
          reason: `Deterministic execution-negation match: "${match[0]}" denies execution but ${toolsCalledInTurn.length} tool(s) ran this turn: [${toolsCalledInTurn.join(", ")}].`,
        }
      }
    }
    return { verified: true, type: "none" }
  }

  for (const pattern of STRUCTURAL_OUTPUT) {
    const match = modelText.match(pattern)
    if (match) {
      return {
        verified: false,
        type: "falsified_execution",
        reason: `Deterministic structural match: "${match[0].slice(0, 80)}" looks like fabricated tool output but no tools were called this turn.`,
      }
    }
  }

  for (const pattern of FIRST_PERSON_CLAIM) {
    const match = modelText.match(pattern)
    if (match) {
      return {
        verified: false,
        type: "falsified_execution",
        reason: `Deterministic first-person claim match: "${match[0]}" asserts past action but no tools were called this turn.`,
      }
    }
  }

  return { verified: true, type: "none" }
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

  // 1.5. Deterministic pre-check: catch fabricated tool output and first-person
  // past-tense claims of action before consulting the LLM auditor. The auditor
  // is fail-open (errors → pass), so the obvious cases must be caught here.
  const deterministic = deterministicFalsifiedExecutionCheck(modelText, toolsCalledInTurn)
  if (!deterministic.verified) {
    return deterministic
  }

  // 2. Ask a fast LLM to semantically judge if the assistant claims system execution
  // or makes future/deferred promises, comparing them with actual tools called.
  // The auditor is language-agnostic: it understands semantics, not keywords.
  const systemPrompt = `You are a silent runtime auditor. Your task is to analyze if the assistant's proposed response has any of the following tool-use mismatches:

1. "hasBrokenPromise": Did the assistant make a verbal promise to the user for a FUTURE/DEFERRED action (e.g., "te aviso en 5 min", "lo reviso luego", "I will run this in the background", "I'll let you know") that would require a deferred/background tool (e.g. schedule_task, delegate_background_task, background_task) to be called now?
   - CRITICAL: If the assistant is doing the action IMMEDIATELY in this turn (e.g. "I will fix it now" coupled with actual file edits or commands executed this turn), this is NOT a future promise. Only flag promises of LATER/DEFERRED actions.

2. "hasFalsifiedExecution": Did the assistant claim or strongly imply that it has executed system commands, run scripts, performed file/directory creation/modification, or transferred/downloaded data in the current turn?
   - Mismatch check: Does it claim this execution but did not call any corresponding tool (or no tools at all)?

3. "hasUnverifiedIncapacity": Did the assistant declare itself UNABLE to perform a task (in any natural language: "I can't", "no puedo", "impossible", "no tengo acceso", "I have no way", "is not available", "no es posible", "I cannot access", etc.) WITHOUT having attempted to verify the limitation in this turn?
   - This applies across all natural languages. The semantic pattern is universal: declaring inability without trying.
   - Mismatch check: Does the assistant assert inability but did not call any tool (or only called a tool that would not surface the relevant limitation, e.g. a memory read when an external action was needed)?
   - EXCEPTION 1: If the assistant called a tool that returned concrete evidence of the limitation (403, 404, ENOENT, permission denied, connection refused, etc.), this is VERIFIED incapacity, not unverified. Only flag cases where the claim is made WITHOUT any verification attempt.
   - EXCEPTION 2: If the user asked a hypothetical or rhetorical question about a tool or capability, an incapacity answer is an explanation, not a claim.
   - EXCEPTION 3: General disclaimers about future scenarios ("I can't predict the future", "I can't know what's in your head") are not claims about a current turn's capability.
   - EXCEPTION 4: Disclaimers about conversational format, length, style, or modality constraints (e.g., "in voice mode I cannot write code", "no puedo darte una respuesta larga por audio", "I cannot send long texts here", "no puedo contestar con markdown") are formatting rules, NOT unverified functional incapacities. Do NOT flag them.

Compare the assistant's claims with the list of tools actually executed in this turn.

Respond strictly in JSON format:
{
  "hasBrokenPromise": boolean,
  "hasFalsifiedExecution": boolean,
  "hasUnverifiedIncapacity": boolean,
  "reason": "brief explanation in English of the mismatch, or empty if none"
}`;

  const userPrompt = `Assistant proposed response: "${modelText}"
Tools executed in this turn: [${toolsCalledInTurn.join(", ")}]`;

  try {
    const { text } = await runBackgroundTextTask(rootDir, systemPrompt, userPrompt, {
      maxTokens: 300,
    })

    const parsed = parseAuditorJson(text)
    if (parsed === null) {
      // Malformed JSON. Try regex fallback before giving up.
      const fallback = parseAuditorJsonByRegex(text)
      if (fallback !== null) {
        if (fallback.hasFalsifiedExecution === true) {
          return {
            verified: false,
            type: "falsified_execution",
            reason: `[regex fallback] ${fallback.reason || "Assistant claims execution without invoking corresponding tools"}`,
          }
        }
        if (fallback.hasBrokenPromise === true) {
          return {
            verified: false,
            type: "broken_promise",
            reason: `[regex fallback] ${fallback.reason || "Assistant made a future promise but did not schedule or delegate a background task"}`,
          }
        }
        if (fallback.hasUnverifiedIncapacity === true) {
          return {
            verified: false,
            type: "unverified_incapacity",
            reason: `[regex fallback] ${fallback.reason || "Assistant declared inability without attempting to verify the limitation"}`,
          }
        }
        // Regex parsed all flags as false — clean pass
        return { verified: true, type: "none" }
      }

      // Both JSON and regex failed. Log and let the turn through.
      console.error(
        `[VERACITY_GUARD_UNVERIFIED] malformed auditor JSON. ` +
        `Raw: ${text.slice(0, 300).replace(/\s+/g, " ")}. ` +
        `Assistant text was NOT validated this turn.`,
      )
      return { verified: true, type: "none" }
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

    if (parsed.hasUnverifiedIncapacity === true) {
      return {
        verified: false,
        type: "unverified_incapacity",
        reason: parsed.reason || "Assistant declared inability without attempting to verify the limitation",
      }
    }
  } catch (error) {
    // Fail-graceful: log the verification gap so it's visible in the daemon stdout
    console.error(
      `[VERACITY_GUARD_UNVERIFIED] auditor failed (${error instanceof Error ? error.message : String(error)}). ` +
      `Assistant text was NOT validated this turn.`,
    )
    return { verified: true, type: "none" }
  }

  return { verified: true, type: "none" }
}

/**
 * Defensive JSON parser for the LLM auditor's response.
 *
 * The auditor is asked to respond with strict JSON, but in practice the model
 * often wraps its answer in a ```json ... ``` markdown fence, prefixes it with
 * prose, or appends trailing text. This parser handles all three cases
 * without throwing — returns `null` when no valid JSON object can be extracted.
 *
 * Strategy (same shape as `parseFicha` in memoryConsolidationPipeline.ts):
 *   1. Trim outer whitespace.
 *   2. If wrapped in a ``` ... ``` fence, extract the inner content.
 *   3. Find the first `{` and the last `}` and parse that substring.
 *   4. Return `null` on any failure (caller logs and fail-opens).
 */
export function parseAuditorJson(raw: string): {
  hasBrokenPromise: boolean
  hasFalsifiedExecution: boolean
  hasUnverifiedIncapacity: boolean
  reason?: string
} | null {
  if (!raw) return null
  let text = raw.trim()
  // Strip ```json ... ``` or ``` ... ``` fence (handle multiline, multiple fences)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) text = fenceMatch[1].trim()
  // Locate the JSON object boundaries defensively
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first < 0 || last < 0 || last <= first) return null
  const candidate = text.slice(first, last + 1)
  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>
    // Minimal shape validation: must have at least one boolean field, otherwise
    // we likely captured a fragment of unrelated prose.
    const hasAnyFlag =
      typeof obj.hasBrokenPromise === "boolean" ||
      typeof obj.hasFalsifiedExecution === "boolean" ||
      typeof obj.hasUnverifiedIncapacity === "boolean"
    if (!hasAnyFlag) return null
    return {
      hasBrokenPromise: Boolean(obj.hasBrokenPromise),
      hasFalsifiedExecution: Boolean(obj.hasFalsifiedExecution),
      hasUnverifiedIncapacity: Boolean(obj.hasUnverifiedIncapacity),
      reason: typeof obj.reason === "string" ? obj.reason : undefined,
    }
  } catch {
    // JSON.parse failed — try to clean up common issues
    // Fix single quotes instead of double quotes (common LLM output issue)
    const cleaned = candidate
      .replace(/'/g, '"')
      .replace(/(\w+):/g, '"$1":')
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/undefined/g, "null")
      .replace(/\b(NaN|Infinity)\b/g, "null")
      // Remove trailing commas before closing braces
      .replace(/,\s*}/g, "}")
      .replace(/,\s*\]/g, "]")
    try {
      const obj = JSON.parse(cleaned) as Record<string, unknown>
      const hasAnyFlag =
        typeof obj.hasBrokenPromise === "boolean" ||
        typeof obj.hasFalsifiedExecution === "boolean" ||
        typeof obj.hasUnverifiedIncapacity === "boolean"
      if (!hasAnyFlag) return null
      return {
        hasBrokenPromise: Boolean(obj.hasBrokenPromise),
        hasFalsifiedExecution: Boolean(obj.hasFalsifiedExecution),
        hasUnverifiedIncapacity: Boolean(obj.hasUnverifiedIncapacity),
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
      }
    } catch {
      return null
    }
  }
}

/**
 * Regex-based fallback parser for the LLM auditor's response.
 * Activates when parseAuditorJson returns null (malformed JSON).
 * Extracts boolean flags directly from the raw text using regex patterns,
 * so the exact JSON format doesn't matter — we just need the key=value pairs.
 *
 * This is a CODE solution (not prompt-based): the model can write prose,
 * markdown, broken JSON, and we still extract the verdict.
 */
export function parseAuditorJsonByRegex(raw: string): {
  hasBrokenPromise: boolean
  hasFalsifiedExecution: boolean
  hasUnverifiedIncapacity: boolean
  reason?: string
} | null {
  if (!raw) return null

  // JSON keys are quoted ("key"), prose may use key=value or key: value.
  // Allow optional quotes and whitespace around the separator.
  const flagPattern = (name: string, value: string) =>
    new RegExp(`${name}\\s*"?\\s*[=:]\\s*"?\\s*${value}`, "i")

  const hasBroken = flagPattern("hasBrokenPromise", "true").test(raw)
  const hasFalsified = flagPattern("hasFalsifiedExecution", "true").test(raw)
  const hasUnverified = flagPattern("hasUnverifiedIncapacity", "true").test(raw)

  // If none of the flags are true, check if at least one was explicitly false
  // (meaning the model did produce a verdict, just all negative)
  const hasBrokenFalse = flagPattern("hasBrokenPromise", "false").test(raw)
  const hasFalsifiedFalse = flagPattern("hasFalsifiedExecution", "false").test(raw)
  const hasUnverifiedFalse = flagPattern("hasUnverifiedIncapacity", "false").test(raw)

  const anyFlagFound = hasBroken || hasFalsified || hasUnverified || hasBrokenFalse || hasFalsifiedFalse || hasUnverifiedFalse
  if (!anyFlagFound) return null

  // Extract reason: look for "reason" followed by : or = and a quoted string
  let reason: string | undefined
  const reasonMatch = raw.match(/"reason"\s*:\s*"([^"]+)"/) ||
    raw.match(/'reason'\s*:\s*'([^']+)'/) ||
    raw.match(/reason\s*[=:]\s*"([^"]+)"/) ||
    raw.match(/reason\s*[=:]\s*'([^']+)'/)
  if (reasonMatch) reason = reasonMatch[1]

  return {
    hasBrokenPromise: hasBroken,
    hasFalsifiedExecution: hasFalsified,
    hasUnverifiedIncapacity: hasUnverified,
    reason,
  }
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
 * Logs an unverified-incapacity guard breach.
 */
export function logUnverifiedIncapacity(rootDir: string, sessionId: string, reason: string, text: string) {
  const preview = text.length > 100 ? text.slice(0, 100) + "..." : text
  appendWorklog(rootDir, sessionId, {
    type: "note",
    summary: `UNVERIFIED_INCAPACITY reason="${reason}" text="${preview}"`,
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
