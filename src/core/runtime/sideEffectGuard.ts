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
}

let guardLogger: Logger | null = null

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
): Promise<SideEffectCheckResult> {
  if (pendingTools.length === 0) return { approved: true }

  // NOTE: The previous version of this function had a hardcoded keyword
  // regex (enviá|forzá|ignorá|skip|salteá) that bypassed the guard for any
  // user message containing those words. That was language-fragile and
  // allowed accidental bypasses (e.g. a user discussing "skip verification"
  // in a past context would trigger the override). The bypass is now the
  // exclusive responsibility of the LLM-judge below — it reasons
  // semantically over the user's full message and the pending tools, so
  // only a clear, contextual Level 0 override is honored.

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
