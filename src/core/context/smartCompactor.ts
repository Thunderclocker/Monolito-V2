import { getRawMessagesForSession, rewriteMessageInPlace, deleteMessages, appendWorklog } from "../session/store.ts";

export interface SmartCompactOptions {
  protectTailTurns?: number;
  forceTier2?: boolean;
}

/**
 * Finds Head and Tail protected zones in the conversation history.
 * Head: System messages + first non-system user/assistant exchange.
 * Tail: Last N complete turns (User -> tools -> Assistant).
 */
export function findProtectedZones(
  messages: Array<{ role: string; text: string }>,
  protectTailTurns = 3
): { headCount: number; tailStartIdx: number } {
  if (messages.length === 0) return { headCount: 0, tailStartIdx: 0 };

  // Head zone: protect system messages and the very first user message + first assistant response
  let headCount = 0;
  while (headCount < messages.length && messages[headCount].role === "system") {
    headCount++;
  }
  
  let userFound = false;
  let assistantFound = false;
  for (let i = headCount; i < messages.length; i++) {
    if (messages[i].role === "user" && !userFound) {
      userFound = true;
      headCount = i + 1;
    } else if (messages[i].role === "assistant" && userFound && !assistantFound) {
      assistantFound = true;
      headCount = i + 1;
      break;
    } else if (messages[i].role === "user" && userFound) {
      // Hit second user message, stop head zone here
      break;
    }
  }

  // Tail zone: protect last N user-initiated turns
  let userCount = 0;
  let tailStartIdx = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      tailStartIdx = i;
      if (userCount >= protectTailTurns) {
        break;
      }
    }
  }

  // Ensure head and tail zones don't overlap
  if (tailStartIdx < headCount) {
    tailStartIdx = headCount;
  }

  return { headCount, tailStartIdx };
}

/**
 * In-memory Tier 1 compaction: snip older large "tool" results in the current turn.
 */
export function compactInMemoryTier1(
  messages: any[],
  charBudget: number
): { messages: any[]; freedChars: number } {
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  if (totalChars <= charBudget) {
    return { messages, freedChars: 0 };
  }

  const PLACEHOLDER = "[tool output compacted to free context]";
  let freedChars = 0;

  // Protect the first 2 messages (head) and the last 4 messages (active tail of the current turn)
  const protectTailCount = 4;
  const tailStart = Math.max(0, messages.length - protectTailCount);

  const newMessages = messages.map((msg, idx) => {
    if (
      idx >= 2 &&
      idx < tailStart &&
      msg.role === "tool" &&
      msg.content &&
      msg.content.length > PLACEHOLDER.length * 2
    ) {
      const before = msg.content.length;
      freedChars += before - PLACEHOLDER.length;
      return {
        ...msg,
        content: PLACEHOLDER,
      };
    }
    return msg;
  });

  return { messages: newMessages, freedChars };
}

/**
 * DB-level Tier 2 compaction: summarizes the intermediate non-protected turns in the database.
 */
export async function smartCompactSession(
  rootDir: string,
  sessionId: string,
  options: SmartCompactOptions = {}
): Promise<{ compacted: boolean; freedChars: number }> {
  const protectTailTurns = options.protectTailTurns ?? 3;
  const rawMessages = getRawMessagesForSession(rootDir, sessionId);

  if (rawMessages.length <= 4) {
    return { compacted: false, freedChars: 0 };
  }

  const { headCount, tailStartIdx } = findProtectedZones(rawMessages, protectTailTurns);

  if (tailStartIdx <= headCount + 1) {
    return { compacted: false, freedChars: 0 };
  }

  const compressibleMessages = rawMessages.slice(headCount, tailStartIdx);
  const totalCompressibleChars = compressibleMessages.reduce((sum, m) => sum + m.text.length, 0);

  // Skip if compressible content is too small, unless forced
  if (totalCompressibleChars < 4000 && !options.forceTier2) {
    return { compacted: false, freedChars: 0 };
  }

  const regionContent = compressibleMessages
    .map(m => `[${m.role.toUpperCase()}]: ${m.text.slice(0, 3000)}`)
    .join("\n\n");

  try {
    // Avoid circular imports by dynamically importing runBackgroundTextTask
    const { runBackgroundTextTask } = await import("../runtime/modelAdapterLite.ts");

    const summaryPrompt = `Genera un resumen conciso, factual y sumamente estructurado del historial intermedio de este chat.
Preservá de forma muy precisa:
1. Hechos concretos, decisiones tomadas y acuerdos.
2. Rutas de archivos, nombres de herramientas usadas y códigos de error encontrados.
3. El estado actual de la tarea y qué falta por hacer.
4. NO repitas detalles de implementación redundantes ni introducciones.
Responde en el mismo idioma de los mensajes intermedios. Máximo 500 palabras.`;

    const summaryResult = await runBackgroundTextTask(
      rootDir,
      summaryPrompt,
      `Historial intermedio a resumir:\n\n${regionContent}`,
      { maxTokens: 1000 }
    );

    const summaryText = `[RESUMEN DE CONTEXTO — ${compressibleMessages.length} turnos resumidos]\n${summaryResult.text}`;

    // Update first message in compressible zone in-place
    const firstMsg = compressibleMessages[0];
    rewriteMessageInPlace(rootDir, firstMsg.id, summaryText, 1);

    // Delete subsequent messages in the compressible zone
    const idsToDelete = compressibleMessages.slice(1).map(m => m.id);
    deleteMessages(rootDir, idsToDelete);

    appendWorklog(rootDir, sessionId, {
      type: "note",
      summary: `Context Engine compacted ${compressibleMessages.length} middle messages into a summary. Freed ~${totalCompressibleChars - summaryText.length} chars.`,
    });

    return {
      compacted: true,
      freedChars: totalCompressibleChars - summaryText.length
    };
  } catch (err) {
    console.error(`[smart-compactor] Failed to generate LLM summary: ${err}`);
    return { compacted: false, freedChars: 0 };
  }
}
