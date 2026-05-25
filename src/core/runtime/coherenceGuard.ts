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
  ) => Promise<{ text: string }>
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

    // 3. Prompt de verificación basado puramente en coherencia lógica universal
    const systemPrompt = `Actúas como el validador universal de consistencia lógica para la respuesta propuesta por el asistente. Tu única función es determinar si existe algún conflicto lógico, contradicción o incompatibilidad (directa o indirecta) entre las afirmaciones de la respuesta propuesta y la información de referencia suministrada (perfil del usuario y hechos de la memoria).

REGLA FUNDACIONAL:
- Si la respuesta propuesta asume condiciones, procedimientos, hechos o entornos que entran en conflicto con las restricciones, realidades o información explícita detallada en la referencia, la respuesta debe considerarse INCOHERENTE.

Responde estrictamente en formato JSON:
{
  "coherent": boolean,
  "reason": "Explicación breve, objetiva y lógica en español de la contradicción detectada si coherent es false, de lo contrario vacío"
}`;

    const userPrompt = `=== PERFIL DEL USUARIO (BOOT_USER) ===
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
