import { readBootWing, recallMemory, appendWorklog } from "../session/store.ts"

export interface CoherenceCheckResult {
  coherent: boolean
  reason?: string
}

export interface RecentToolCall {
  tool: string
  ok: boolean
  at?: string
  /**
   * Fix C (2026-06-10): the input object for the tool call. Used to
   * distinguish tool actions (e.g. VoiceClone `list` vs `list_remote`)
   * when validating scope-claims. Optional because legacy callers
   * (tests) do not always supply it.
   */
  input?: Record<string, unknown>
}

/**
 * Bug #8 (09-jun-2026): capability snapshot passed to the LLM judge so it
 * can validate 'claims of limitation' against ground truth. Without this,
 * the agent can claim 'Bash can't reach the host' or 'I don't have
 * access to docker' and the judge has no way to know the claim is false.
 * Before: empirically the agent did exactly that — said "Bash no sale al
 * host" when Bash has full host access (confirmed by `docker ps` running
 * 3 containers from the runtime CWD).
 */
export interface AvailableCapabilities {
  tools: Array<{ name: string; description?: string }>
  bins: string[]
}

export const DEFAULT_AVAILABLE_BINS = [
  "docker",
  "git",
  "ssh",
  "curl",
  "ls",
  "cat",
  "grep",
  "find",
  "ps",
  "awk",
  "sed",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "tr",
  "cut",
  "xargs",
  "tee",
  "rm",
  "cp",
  "mv",
  "mkdir",
  "chmod",
  "tar",
  "gzip",
  "node",
  "npm",
  "npx",
  "python3",
  "bash",
  "sh",
] as const

/**
 * Valida síncronamente si la respuesta propuesta contradice la información de referencia.
 */
export async function checkTurnCoherence(
  rootDir: string,
  modelText: string,
  profileId: string,
  runBackgroundTextTask: (
    rootDir: string,
    system: string,
    userPrompt: string,
    options?: { model?: string; maxTokens?: number }
  ) => Promise<{ text: string }>,
  recentMessages?: Array<{ role: string; text: string }>,
  availableCapabilities?: AvailableCapabilities,
  recentToolCalls?: RecentToolCall[]
): Promise<CoherenceCheckResult> {
  if (!modelText || modelText.trim().length < 15) {
    return { coherent: true }
  }

  // Fix C (2026-06-10): deterministic pre-check that catches tool-scope
  // mismatches BEFORE the LLM-judge. Specifically: when the model claims
  // it queried MiniMax/remote but only called `VoiceClone list` (local
  // config), the LLM-judge was the only line of defense and was being
  // over-bypassed. With this check we catch the most common false-execution
  // pattern (incident 2026-06-10T20:52:47) deterministically.
  if (recentToolCalls && recentToolCalls.length > 0) {
    const scopeMismatch = detectRemoteClaimWithoutRemoteTool(modelText, recentToolCalls)
    if (scopeMismatch) {
      return { coherent: false, reason: scopeMismatch }
    }
  }

  try {
    // 1. Cargar perfil del usuario fijo (Filtro Determinista)
    const bootUser = readBootWing(rootDir, "BOOT_USER", profileId) ?? ""

    // 2. Cargar memorias del Palace afines semánticamente (Filtro Dinámico)
    let semanticMemories = ""
    try {
      const recalled = await recallMemory(rootDir, undefined, undefined, modelText, profileId)
      if (recalled && recalled.length > 0) {
        semanticMemories = recalled
          .slice(0, 3)
          .map((m: any) => `- [Memoria: ${m.room}/${m.key ?? ""}] ${m.content}`)
          .join("\n")
      }
    } catch (e) {
      // Fallback silencioso si RAG semántico no está listo
    }

    let recentChatContext = ""
    if (recentMessages && recentMessages.length > 0) {
      recentChatContext = [
        "=== CONVERSACIÓN RECIENTE (CHAT) ===",
        recentMessages.map(m => `[${m.role.toUpperCase()}]: ${m.text}`).join("\n"),
        ""
      ].join("\n")
    }

    let recentToolsContext = ""
    if (recentToolCalls && recentToolCalls.length > 0) {
      recentToolsContext = [
        "=== HERRAMIENTAS EJECUTADAS RECIENTEMENTE ===",
        recentToolCalls.map(t => `- ${t.tool} (ok=${t.ok})${t.at ? ` @ ${t.at}` : ""}`).join("\n"),
        ""
      ].join("\n")
    }

    // 3. Build the capabilities block. If no snapshot was passed (legacy
    //    callers, tests), still emit a generic block so the judge has
    //    SOMETHING to compare against instead of going blind.
    const capabilitiesBlock = renderCapabilitiesBlock(availableCapabilities)

    // 4. Prompt de verificación basado puramente en coherencia lógica universal.
    //    Language-agnostic: el judge razona semánticamente, los ejemplos cubren
    //    varios idiomas para que el patrón (no las palabras) sea lo que detecta.
    const systemPrompt = `You are the universal logical-consistency validator for the assistant's proposed response. Your only function is to determine whether there is any logical conflict, contradiction, or incompatibility (direct or indirect) between the assertions in the proposed response and the supplied reference information (recent conversation, user profile, and memory facts).

  FOUNDATIONAL RULE:
- If the proposed response assumes conditions, procedures, facts, or environments that conflict with the constraints, realities, or explicit information detailed in the reference, the response MUST be considered INCOHERENT.
- CONTEXT RULE: Conditional directives in the user profile (e.g. "respond only with literal description to photos", "no meta-answers", etc.) MUST only be enforced if the recent conversation in this turn actively meets that condition (e.g. the user actually sent an image). Do not reject responses that discuss memories, rules, or pets in a general memory conversation if the user is asking for it in their chat prompt.
- AUTONOMY AND EXECUTION RULE: The Monolito assistant has access to very powerful local tools (Bash terminal, file read/write tools, background task delegation, web search, vision, etc.). Therefore, it is a direct INCOHERENCE and lack of autonomy if the proposed response delegates, transfers, or asks the user to run commands on their own console, execute test scripts on their personal terminal, or perform technical/manual diagnostic tasks on their local operating system that the assistant itself should be able to orchestrate via its own tools. If the response contains requests of this type, you MUST mark it as INCOHERENT.
- TOOL EXECUTION GROUND TRUTH: If the proposed response claims that the assistant "envió", "mandó", "generó", "descargó", "buscó" or otherwise performed an action (e.g. "envié las imágenes de Bulma", "mandé la foto", "generé la imagen"), you MUST check the HERRAMIENTAS EJECUTADAS RECIENTEMENTE list. If the corresponding tool (TelegramSendPhoto, GenerateImage, DownloadFile, ImageSearch, WebSearch, etc.) appears with ok=true in that list, the claim is VALID. If the tool does NOT appear, the claim is INCOHERENT (false execution claim).

INCOHERENT PATTERNS (any language — judge by MEANING, not keywords):
- Resolution of "how to do X" deferred to the user
- Final phrases like "awaiting your decision", "tell me which option", "espero tu decisión", "decime cuál", "let me know how to proceed", "run it yourself and tell me", "ejecutalo vos", "I'll let you choose", "avísame y lo hago", "you pick"
- Proposals ending with multiple options the user must pick from, when the agent has the tools to evaluate them itself
- Reports framed as success ("done", "listo", "completado", "verified", "INTACTO", "todo bien", "all set") when no tool was executed in this turn to support the claim
- Responses that ask the user to run shell commands, paste results, ssh into a server, or perform tasks the assistant could orchestrate via its own tools
- A status report about a task being complete when the task itself was never executed (e.g. "the system state is unchanged" reported as a positive outcome when the user asked for a state CHANGE)

ALSO INCOHERENT (sub-agent context):
- A sub-agent asking for delegation to another worker, escalation, or "I need a different agent with X access"
- A sub-agent reporting the literal verification tag (the agent's standard sub-agent success tag) when the response also says the task was not completed

FALSIFIED LIMITATION CLAIM (bug #8, 09-jun-2026):
- If the response claims the agent CANNOT or DOES NOT HAVE access to a capability that IS in fact available per the CAPABILIDADES list below, mark it as INCOHERENT.
- Examples that MUST be marked INCOHERENT when the capability is listed below:
  - "Bash can't reach the host" / "Bash no sale al host" / "Bash solo ejecuta dentro del workspace" — when Bash is in the tools list
  - "I don't have access to docker" / "no tengo docker" / "docker is not available" — when docker is in the bins list
  - "I cannot read files outside the workspace" / "no puedo leer archivos" — when Read is in the tools list
  - "I have no visibility of running processes" / "no veo tus contenedores" — when Bash (with docker ps) is in the tools list
  - "I don't have git" / "no tengo git instalado" — when git is in the bins list
- Mark these as INCOHERENT with a reason like: "The response falsely claims limitation X, but the capability is in fact available (see CAPABILIDADES). The agent can execute the task itself."
- Do NOT mark as INCOHERENT legitimate limitations (e.g. "I don't have access to the Slack API" when Slack is not in the tools list — that's a true limitation).

Respond strictly in JSON format:
{
  "coherent": boolean,
  "reason": "Brief, objective explanation of the contradiction detected (in the same language as the response). Empty if coherent is true."
}`;

    const userPrompt = `${recentChatContext}${recentToolsContext}=== PERFIL DEL USUARIO (BOOT_USER) ===
 ${bootUser}

 === MEMORIAS SEMÁNTICAS RELACIONADAS ===
 ${semanticMemories || "(No hay memorias semánticas relacionadas)"}

 ${capabilitiesBlock}

 === RESPUESTA A EVALUAR ===
 "${modelText}"`;

    const { text } = await runBackgroundTextTask(rootDir, systemPrompt, userPrompt, {
      maxTokens: 120,
    });

    const parsed = JSON.parse(text.trim());
    return {
      coherent: parsed.coherent !== false,
      reason: parsed.reason || undefined,
    };
  } catch (error) {
    // Fallback de seguridad operativa: dejar pasar el turno si algo falla en la validación
    return { coherent: true };
  }
}

/**
 * Render the capabilities block for the system prompt. Exported for
 * testing.
 */
export function renderCapabilitiesBlock(caps?: AvailableCapabilities): string {
  if (!caps) {
    // Legacy fallback: emit a default block based on DEFAULT_AVAILABLE_BINS.
    // This is worse than a real snapshot but better than nothing.
    return `=== CAPACIDADES DISPONIBLES ===
Tools: (snapshot no provisto; el judge debe ser conservador con limitation claims)
Host bins: ${DEFAULT_AVAILABLE_BINS.join(", ")}`
  }
  const toolNames = caps.tools.map(t => t.name).join(", ")
  const binList = caps.bins.length > 0 ? caps.bins.join(", ") : "(no bin snapshot provided)"
  return `=== CAPACIDADES DISPONIBLES ===
Tools registradas: ${toolNames || "(ninguna)"}
Host bins disponibles en PATH: ${binList}`
}

/**
 * Registra el fallo de coherencia en la base de datos para auditoría
 */
export function logCoherenceBreach(rootDir: string, sessionId: string, reason: string, text: string) {
  appendWorklog(rootDir, sessionId, {
    type: "note",
    summary: `COHERENCE_GUARD_REJECTED: "${reason}" | Original: "${text.slice(0, 80)}..."`,
  })
}

// -----------------------------------------------------------------------------
// Fix C (2026-06-10): deterministic tool-scope mismatch detection.
//
// Catches a class of hallucinations the LLM-judge was letting through:
// the model claims it queried a REMOTE source (MiniMax, the provider,
// the cloud) but only called the LOCAL tool. For VoiceClone specifically,
// `list` reads the local config (CONF_CHANNELS.tts.clonedVoices) and
// `list_remote` queries MiniMax. If the user asked about "voces en
// MiniMax" and the model only called `list`, the response is incoherent
// regardless of what the model claims about MiniMax.
//
// This is exported for testing.
// -----------------------------------------------------------------------------

const REMOTE_SCOPE_CLAIM_PATTERNS: RegExp[] = [
  // Spanish
  /\b(en\s+minimax|en\s+el\s+provider|minimax\s+tiene|minimax\s+me\s+muestra|minimax\s+devuelve|minimax\s+devolvi(ó|o)|en\s+la\s+nube|en\s+el\s+servidor|remot(amente|o)s?|en\s+el\s+proveedor|el\s+provider)/i,
  /\b(list(é|e|o)\s+.*\s+(en\s+minimax|en\s+el\s+provider|remot(amente|o)|en\s+la\s+nube))/i,
  /\b(0|ninguna|ninguno|cero)\s+voces\s+(en\s+minimax|en\s+el\s+provider|en\s+la\s+nube|remot(amente|o)s?)/i,
  // English
  /\b(in\s+minimax|in\s+the\s+provider|on\s+minimax|minimax\s+(has|shows|returns)|remote\s+voices?|in\s+the\s+cloud)/i,
  /\b(listed\s+.*\s+voices\s+on\s+minimax|remote\s+voice\s+list|minimax\s+voice\s+list)/i,
]

/**
 * Returns a human-readable reason if the model claims a remote/MiniMax
 * result but only called the local-list variant of VoiceClone. Returns
 * null when no scope mismatch is detected (or when there is no claim).
 */
export function detectRemoteClaimWithoutRemoteTool(
  modelText: string,
  recentToolCalls: RecentToolCall[],
): string | null {
  if (!modelText) return null

  const claim = REMOTE_SCOPE_CLAIM_PATTERNS.some(p => p.test(modelText))
  if (!claim) return null

  // Focus on VoiceClone specifically because it has the list/list_remote
  // distinction that gets confused. Other tools with similar scope
  // ambiguity can be added here.
  const voiceCloneCalls = recentToolCalls.filter(t => t.tool === "VoiceClone")
  if (voiceCloneCalls.length === 0) return null

  const listRemoteCalled = voiceCloneCalls.some(t => t.input?.action === "list_remote")
  if (listRemoteCalled) return null  // remote was called, no mismatch

  // Determine if every VoiceClone call is the local-list variant. If
  // some are other actions (purge, clone, etc.) without list_remote, we
  // don't flag — those have their own scope semantics.
  const onlyLocalList = voiceCloneCalls.every(t => t.input?.action === "list")
  if (!onlyLocalList) return null

  return `Response claims a remote/MiniMax result, but only VoiceClone with action='list' (local config) was called this turn. To answer about voices in MiniMax, call VoiceClone with action='list_remote' (GET /v1/get_voice), or qualify the answer as "local config only".`
}
