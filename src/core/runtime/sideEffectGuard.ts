import { readBootWing, recallMemory, appendWorklog } from "../session/store.ts"

export interface SideEffectCheckResult {
  approved: boolean
  reason?: string
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

  // 3. LLM evaluation
  const systemPrompt = `Eres el validador de side-effects del runtime Monolito V2. Tu función es decidir si las herramientas con efectos externos irreversibles (envíos por Telegram, llamadas a APIs externas, etc.) deben ejecutarse ahora o si falta algún paso previo que el usuario o las buenas prácticas exigen.

CONTEXTO QUE RECIBIRÁS:
- Perfil del usuario con sus preferencias y reglas personales
- Memorias relevantes del historial
- Lista de herramientas YA ejecutadas con éxito en este turno
- Lista de herramientas con side-effect PENDIENTES de ejecutar
- Último mensaje del usuario (intent)

REGLA FUNDAMENTAL:
- Si el perfil del usuario o las memorias contienen alguna directiva, preferencia, o instrucción que exija pasos previos antes de ejecutar una herramienta pendiente, y esos pasos NO se cumplieron → rechazar.
- EXCEPCIÓN SUPREMA (LEVEL 0): Las instrucciones explícitas y activas del usuario en su último mensaje SIEMPRE tienen prioridad absoluta y anulan cualquier memoria guardada, preferencia de perfil o regla del sistema. Si el usuario ordena explícitamente saltear, evitar o ignorar un paso previo (ej: "sin verificar", "no verifiques", "skip verification"), DEBES obedecer al usuario y APROBAR la ejecución. El usuario es el dueño y operador supremo del sistema.
- Si no hay ninguna directiva relevante y el flujo tiene sentido lógico (las herramientas pendientes son coherentes con el intent del usuario) → aprobar.
- En caso de duda, aprobar. No bloquear sin razón.

Responde SOLO en JSON:
{
  "approved": boolean,
  "reason": "Explicación breve en español si approved es false, vacío si es true"
}`

  const userPrompt = `=== PERFIL DEL USUARIO ===
${bootUser || "(Sin perfil)"}

=== MEMORIAS RELEVANTES ===
${semanticMemories || "(Ninguna)"}

=== HERRAMIENTAS YA EJECUTADAS ===
${executedTools.length > 0 ? executedTools.join(", ") : "(Ninguna)"}

=== HERRAMIENTAS PENDIENTES (SIDE-EFFECTS) ===
${pendingTools.map(t => `${t.name}(${JSON.stringify(t.input).slice(0, 200)})`).join("\n")}

=== ÚLTIMO MENSAJE DEL USUARIO ===
"${lastUserMessage}"`

  try {
    const { text } = await runBackgroundTextTask(rootDir, systemPrompt, userPrompt, {
      maxTokens: 120,
    })
    const parsed = JSON.parse(text.trim())
    return {
      approved: parsed.approved !== false,
      reason: parsed.reason || undefined,
    }
  } catch (e) {
    // Fail-safe: aprobar si el guard falla (mismo principio que coherenceGuard)
    return { approved: true }
  }
}
