import { readBootWing, recallMemory } from "../session/store.ts"
import { type Logger } from "../logging/logger.ts"

export interface SideEffectCheckResult {
  approved: boolean
  reason?: string
  /**
   * If the Level 0 user override was explicitly detected by the LLM-judge,
   * this flag is set to true so the audit trail records WHY the guard let
   * a side-effect tool through despite a profile-level directive.
   */
  level0OverrideDetected?: boolean
  /**
   * Set to true when the guard auto-approved media tools because the
   * session has /adult enabled. Distinct from level0OverrideDetected so
   * audit trails can tell the two bypass paths apart.
   */
  adultModeAutoApproved?: boolean
}

/**
 * Tools that the guard considers "media side-effects" — i.e. tools that
 * produce or deliver content (audio, image, video, text-to-telegram) and
 * are subject to content-policy scrutiny by the LLM-judge. When the
 * session has /adult enabled (adultMode=true), these tools are
 * auto-approved without invoking the judge, because adult mode is the
 * user's explicit opt-in to lift content restrictions.
 *
 * Destructive tools (Bash with `rm -rf`, etc.) are intentionally NOT
 * in this list — adult mode lifts content restrictions, not safety
 * guard-rails. The destructive-action guard is a separate layer.
 */
const ADULT_MODE_MEDIA_TOOLS = new Set([
  "TelegramSend",
  "TelegramSendPhoto",
  "TelegramSendAudio",
  "TelegramSendVoice",
  "TelegramSendDocument",
  "GenerateImage",
  "GenerateSpeech",
  "VoiceClone",
  "TranscribeAudio",
])

let guardLogger: Logger | null = null

/**
 * Fix 4 (2026-06-10): patterns for the destructive-imperative pre-check.
 * Only destructive side-effect tools (VoiceClone purge, Bash) get the
 * short-circuit. Media/content tools (TelegramSend, GenerateImage, etc.)
 * always go through the full LLM-judge for content verification.
 */
const DESTRUCTIVE_IMPERATIVE_PATTERN = /^\s*(elimina|borra|delete|remove|purge|drop|borrar|quitar|eliminar|remover|borrame|quitame|elimina\s+esa|elimina\s+esas|borra\s+esa|borra\s+esas)\b/i
const DESTRUCTIVE_SIDE_EFFECT_TOOLS = new Set(["VoiceClone", "Bash"])

/**
 * Fix 4 (2026-06-10): deterministic pre-check that approves a side-effect
 * call when the user's message starts with a clear destructive verb and
 * every pending tool is in the destructive whitelist. Avoids the LLM-judge
 * over-blocking pipe-table formats like
 *   `elimina | amanda_voz | 2026-06-09 | | cristian | 2026-06-09 |`
 * which were getting rejected as "no imperativo claro".
 */
function isClearDestructiveImperative(
  lastUserMessage: string,
  pendingTools: Array<{ name: string }>,
): boolean {
  if (!lastUserMessage) return false
  if (!DESTRUCTIVE_IMPERATIVE_PATTERN.test(lastUserMessage.trim())) return false
  return pendingTools.length > 0 && pendingTools.every(t => DESTRUCTIVE_SIDE_EFFECT_TOOLS.has(t.name))
}

/**
 * Fix D (2026-06-10): read-only side-effect calls are auto-approved
 * without invoking the LLM-judge. Some tools have `sideEffect: true`
 * because they can perform destructive actions (purge, clone), but their
 * `list`/`list_remote` actions are pure GETs that have no external
 * effect. Sending these through the judge produced false-positive
 * blocks (incident 2026-06-10T20:46:40 where list_remote was blocked
 * with "the user asked to delete all voices..."), and the model then
 * hallucinated the result instead of calling the tool.
 */
function isReadOnlySideEffectCall(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "VoiceClone") {
    const action = input.action
    return action === "list" || action === "list_remote"
  }
  return false
}

/**
 * Inject a logger so the guard can emit structured `logger.warn` events
 * when it rejects a side-effect tool. The events land in
 * `~/.monolito/logs/monolitod.log` (and the daemon's stdout) so users
 * and agents can `grep "[SideEffectGuard]"` to diagnose why a Telegram
 * send or other irreversible tool was blocked.
 *
 * The injection is a one-shot: callers (typically the runtime at
 * construction time) pass the daemon logger and forget. Tests can pass
 * `null` to disable logging.
 */
export function setSideEffectGuardLogger(logger: Logger | null) {
  guardLogger = logger
}

export async function checkSideEffects(
  rootDir: string,
  pendingTools: Array<{ name: string; input: Record<string, unknown> }>,
  executedTools: string[],
  profileId: string,
  lastUserMessage: string,
  runBackgroundTextTask: (
    rootDir: string,
    system: string,
    userPrompt: string,
    options?: { model?: string; maxTokens?: number }
  ) => Promise<{ text: string }>,
  options?: { adultMode?: boolean },
): Promise<SideEffectCheckResult> {
  if (pendingTools.length === 0) return { approved: true }

  // Adult mode short-circuit: when the session has /adult enabled AND
  // every pending tool is a media/content tool, the guard skips the
  // LLM-judge and approves directly. /adult is the user's explicit
  // opt-in to lift content restrictions; re-running the judge would
  // just produce the same false-positive block the user already
  // opted out of (e.g. the audio "mandame un audio con tu descripcion
  // de tus tetas" was rejected with no /adult awareness).
  if (options?.adultMode === true) {
    const onlyMediaTools = pendingTools.every(t => ADULT_MODE_MEDIA_TOOLS.has(t.name))
    if (onlyMediaTools) {
      const pendingSummary = pendingTools
        .map(t => `${t.name}(${JSON.stringify(t.input).slice(0, 80)})`)
        .join(", ")
      guardLogger?.warn(
        `[SideEffectGuard] ADULT_MODE_AUTO_APPROVE profileId=${profileId} ` +
        `pendingTools=[${pendingSummary}] ` +
        `lastUserMessage=${JSON.stringify(lastUserMessage).slice(0, 200)}`,
      )
      return { approved: true, adultModeAutoApproved: true }
    }
  }

  // Fix D (2026-06-10): if every pending tool is a read-only side-effect
  // call (e.g. VoiceClone list/list_remote), approve without invoking
  // the LLM-judge. These are pure GETs against external providers; they
  // have no external effect and the user explicitly asked for the
  // information. The LLM-judge was over-blocking these with stale
  // context ("the user asked to delete all voices..."), which caused
  // the model to hallucinate the result instead of calling the tool.
  const allReadOnly = pendingTools.every(t => isReadOnlySideEffectCall(t.name, t.input))
  if (allReadOnly) {
    const pendingSummary = pendingTools
      .map(t => `${t.name}(${JSON.stringify(t.input).slice(0, 80)})`)
      .join(", ")
    guardLogger?.warn(
      `[SideEffectGuard] READ_ONLY_BYPASS profileId=${profileId} ` +
      `pendingTools=[${pendingSummary}] ` +
      `lastUserMessage=${JSON.stringify(lastUserMessage).slice(0, 200)}`,
    )
    return { approved: true }
  }

  // NOTE: The previous version of this function had a hardcoded keyword
  // regex (enviá|forzá|ignorá|skip|salteá) that bypassed the guard for any
  // user message containing those words. That was language-fragile and
  // allowed accidental bypasses (e.g. a user discussing "skip verification"
  // in a past context would trigger the override). The bypass is now the
  // exclusive responsibility of the LLM-judge below — it reasons
  // semantically over the user's full message and the pending tools, so
  // only a clear, contextual Level 0 override is honored.

  // Fix 4 (2026-06-10): deterministic pre-check for clear destructive
  // imperatives. The LLM-judge was rejecting pipe-table formats like
  // `elimina | amanda_voz | 2026-06-09 | | cristian | 2026-06-09 |` as
  // "not a clear imperative" even though the first cell of the table is
  // itself a destructive verb. We short-circuit before the judge ONLY
  // when the message starts with a destructive verb AND every pending
  // tool is in the explicit destructive whitelist (VoiceClone purge,
  // Bash). This keeps the bypass narrow: media tools (TelegramSend,
  // GenerateImage, etc.) still go through the full judge for content
  // verification.
  if (isClearDestructiveImperative(lastUserMessage, pendingTools)) {
    const pendingSummary = pendingTools
      .map(t => `${t.name}(${JSON.stringify(t.input).slice(0, 80)})`)
      .join(", ")
    guardLogger?.warn(
      `[SideEffectGuard] IMPERATIVE_BYPASS profileId=${profileId} ` +
      `pendingTools=[${pendingSummary}] ` +
      `lastUserMessage=${JSON.stringify(lastUserMessage).slice(0, 200)}`,
    )
    return { approved: true }
  }

  // 1. Cargar perfil del usuario (contiene preferencias dictadas en lenguaje natural)
  const bootUser = readBootWing(rootDir, "BOOT_USER", profileId) ?? ""

  // 2. Recall semántico: buscar memorias relevantes al contexto
  //    (e.g. si el usuario alguna vez dijo "verificá las fotos")
  const contextQuery = pendingTools.map(t => t.name).join(" ") + " " + lastUserMessage
  let semanticMemories = ""
  try {
    const recalled = await recallMemory(rootDir, undefined, undefined, contextQuery, profileId)
    if (recalled && recalled.length > 0) {
      semanticMemories = recalled
        .slice(0, 3)
        .map((m: any) => `- [${m.wing}/${m.room}] ${m.content}`)
        .join("\n")
    }
  } catch (e) {
    // Fallback silencioso si RAG semántico no está listo
  }

  // 3. LLM evaluation. The judge is fully language-agnostic: it reasons
  // about the user's intent in any language and only honors a Level 0
  // override when the user EXPLICITLY (in the current turn) directs the
  // agent to skip or bypass a prerequisite. Hypothetical, past, or
  // third-party references do NOT count as overrides.
  const systemPrompt = `You are the side-effect validator for the Monolito V2 runtime. Your job is to decide whether external irreversible-effect tools (Telegram sends, external API calls, etc.) should execute now, or whether a prerequisite the user or best practices require is missing.

INPUT YOU WILL RECEIVE:
- User profile with personal preferences and rules
- Relevant historical memories
- Tools that have ALREADY executed successfully this turn
- Tools with side-effect PENDING execution
- The user's most recent message (intent)

CORE RULE:
- If the user profile or the memories contain a directive, preference, or instruction that requires prerequisite steps before executing a pending tool, and those steps were NOT done → reject.
- SUPREME EXCEPTION (LEVEL 0): The user's explicit and ACTIVE instructions in their most recent message ALWAYS take absolute priority and override any stored memory, profile preference, or system rule. If the user explicitly orders the agent to skip, avoid, or ignore a prerequisite (any language — e.g. "send it anyway", "no verifiques", "skip verification", "force it", "without checking", "no me importa, mandá"), you MUST obey the user and APPROVE execution. The user is the supreme owner and operator of this system.
- LEVEL 0 OVERRIDE STRICT CRITERIA: The override must be in the user's CURRENT turn, addressed to the assistant in imperative form, and clearly refer to the pending tool or its prerequisite. Hypothetical, past, or third-party references do NOT count. Examples that ARE overrides: "send it without checking", "no verifiques, mandá ya", "force send the message", "no me importa, hazlo". Examples that are NOT overrides: "last time I told you to skip verification", "users sometimes want to skip checks", "the docs say you can skip".
- If no relevant directive exists and the flow makes logical sense (the pending tools are coherent with the user's intent) → approve.
- In doubt, approve. Do not block without reason.

Respond ONLY in JSON:
{
  "approved": boolean,
  "level0Override": boolean,
  "reason": "Brief explanation in the same language as the user's message. Empty if approved is true."
}`

  const userPrompt = `=== USER PROFILE (BOOT_USER) ===
${bootUser || "(No profile)"}

=== RELEVANT MEMORIES ===
${semanticMemories || "(None)"}

=== TOOLS ALREADY EXECUTED ===
${executedTools.length > 0 ? executedTools.join(", ") : "(None)"}

=== PENDING TOOLS (SIDE-EFFECTS) ===
${pendingTools.map(t => `${t.name}(${JSON.stringify(t.input).slice(0, 200)})`).join("\n")}

=== USER'S MOST RECENT MESSAGE ===
"${lastUserMessage}"`

  try {
    const { text } = await runBackgroundTextTask(rootDir, systemPrompt, userPrompt, {
      maxTokens: 200,
    })
    const parsed = JSON.parse(stripMarkdownCodeFence(text).trim())
    const approved = parsed.approved !== false
    const level0Override = parsed.level0Override === true
    if (!approved) {
      // Structured warn so the audit trail is greppable in
      // monolitod.log. Format intentionally stays one-line JSON-ish so
      // tools like `grep "[SideEffectGuard]" ~/.monolito/logs/monolitod.log`
      // can surface the exact reason + pending tool list at a glance.
      const pendingSummary = pendingTools
        .map(t => `${t.name}(${JSON.stringify(t.input).slice(0, 80)})`)
        .join(", ")
      guardLogger?.warn(
        `[SideEffectGuard] BLOCKED profileId=${profileId} ` +
        `adultMode=${options?.adultMode === true ? "true" : "false"} ` +
        `pendingTools=[${pendingSummary}] ` +
        `reason=${JSON.stringify(parsed.reason || "").slice(0, 240)} ` +
        `lastUserMessage=${JSON.stringify(lastUserMessage).slice(0, 200)}`,
      )
    }
    return {
      approved,
      reason: parsed.reason || undefined,
      level0OverrideDetected: level0Override || undefined,
    }
  } catch (e) {
    // Fail-safe: aprobar si el guard falla (mismo principio que coherenceGuard)
    guardLogger?.warn(
      `[SideEffectGuard] LLM_JUDGE_FAILED falling back to approve. ` +
      `profileId=${profileId} ` +
      `pendingTools=[${pendingTools.map(t => t.name).join(", ")}] ` +
      `error=${e instanceof Error ? e.message : String(e)}`,
    )
    return { approved: true }
  }
}

/**
 * Strip markdown code-fence wrappers from an LLM JSON response. Some
 * judges wrap the JSON object in ```json ... ``` even when told to
 * respond with raw JSON. Without this, JSON.parse throws.
 */
function stripMarkdownCodeFence(text: string): string {
  if (!text) return text
  const trimmed = text.trim()
  const fenceMatch = trimmed.match(/^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```\s*$/)
  if (fenceMatch?.[1]) return fenceMatch[1].trim()
  return trimmed
}

export interface GuardBlockRecord {
  /** ISO timestamp from the worklog. */
  at: string
  /** The full reason string the LLM-judge returned (or the failure message). */
  reason: string
  /** The Level 0 user override that bypassed the guard, if any. */
  level0Override: boolean
}

/**
 * Return the most recent N guard events for a given session, ordered
 * newest-first. Pulls from the SQLite worklog (not the daemon log) so
 * the helper survives daemon restarts and is accessible from the
 * QueryGuardStatus tool without re-parsing text logs.
 *
 * Recognized prefixes (written by the runtime/modelAdapter paths):
 * - `SIDE_EFFECT_GUARD_BLOCKED: <reason>`  →  block event
 * - `SIDE_EFFECT_GUARD: Level 0 user override honored. Pending tools: [...]`
 *                                    →  bypass event
 *
 * The `level0Override` field tells the caller which side of the
 * guard the event came from; an LLM consuming this list can answer
 * "why was my send blocked" with a real reason rather than
 * hallucinating one.
 */
export function getRecentGuardBlocks(
  rootDir: string,
  sessionId: string,
  limit = 20,
): GuardBlockRecord[] {
  if (!sessionId) return []
  try {
    const { getDb } = require("../session/store.ts") as typeof import("../session/store.ts")
    const db = getDb(rootDir)
    const rows = db
      .prepare(
        `SELECT at, summary FROM worklog
         WHERE session_id = ? AND (
           summary LIKE 'SIDE_EFFECT_GUARD_BLOCKED:%' OR
           summary LIKE 'SIDE_EFFECT_GUARD:%'
         )
         ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Array<{ at: string; summary: string }>
    return rows.map(r => {
      const isBlock = r.summary.startsWith("SIDE_EFFECT_GUARD_BLOCKED:")
      const reason = isBlock
        ? r.summary.slice("SIDE_EFFECT_GUARD_BLOCKED:".length).trim()
        : r.summary
      return {
        at: r.at,
        reason,
        level0Override: !isBlock,
      }
    })
  } catch {
    return []
  }
}
