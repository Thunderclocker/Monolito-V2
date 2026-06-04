import { readBootWing, recallMemory, appendWorklog } from "../session/store.ts"
import { generateEmbedding } from "../session/embeddings.ts"

export interface CoherenceCheckResult {
  coherent: boolean
  reason?: string
}

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
  recentMessages?: Array<{ role: string; text: string }>
): Promise<CoherenceCheckResult> {
  if (!modelText || modelText.trim().length < 15) {
    return { coherent: true }
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

    // 3. Prompt de verificación basado puramente en coherencia lógica universal.
    //    Language-agnostic: el judge razona semánticamente, los ejemplos cubren
    //    varios idiomas para que el patrón (no las palabras) sea lo que detecta.
    const systemPrompt = `You are the universal logical-consistency validator for the assistant's proposed response. Your only function is to determine whether there is any logical conflict, contradiction, or incompatibility (direct or indirect) between the assertions in the proposed response and the supplied reference information (recent conversation, user profile, and memory facts).

FOUNDATIONAL RULE:
- If the proposed response assumes conditions, procedures, facts, or environments that conflict with the constraints, realities, or explicit information detailed in the reference, the response MUST be considered INCOHERENT.
- CONTEXT RULE: Conditional directives in the user profile (e.g. "respond only with literal description to photos", "no meta-answers", etc.) MUST only be enforced if the recent conversation in this turn actively meets that condition (e.g. the user actually sent an image). Do not reject responses that discuss memories, rules, or pets in a general memory conversation if the user is asking for it in their chat prompt.
- AUTONOMY AND EXECUTION RULE: The Monolito assistant has access to very powerful local tools (Bash terminal, file read/write tools, background task delegation, web search, vision, etc.). Therefore, it is a direct INCOHERENCE and lack of autonomy if the proposed response delegates, transfers, or asks the user to run commands on their own console, execute test scripts on their personal terminal, or perform technical/manual diagnostic tasks on their local operating system that the assistant itself should be able to orchestrate via its own tools. If the response contains requests of this type, you MUST mark it as INCOHERENT.

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

Respond strictly in JSON format:
{
  "coherent": boolean,
  "reason": "Brief, objective explanation of the contradiction detected (in the same language as the response). Empty if coherent is true."
}`;

    const userPrompt = `${recentChatContext}=== PERFIL DEL USUARIO (BOOT_USER) ===
${bootUser}

=== MEMORIAS SEMÁNTICAS RELACIONADAS ===
${semanticMemories || "(No hay memorias semánticas relacionadas)"}

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
 * Registra el fallo de coherencia en la base de datos para auditoría
 */
export function logCoherenceBreach(rootDir: string, sessionId: string, reason: string, text: string) {
  appendWorklog(rootDir, sessionId, {
    type: "note",
    summary: `COHERENCE_GUARD_REJECTED: "${reason}" | Original: "${text.slice(0, 80)}..."`,
  })
}
