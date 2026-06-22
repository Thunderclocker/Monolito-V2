import { getContextBudget } from "./contextLimits.ts";

const MIDDLE_OMISSION_MARKER = "\n\n⚠️ [... contenido intermedio omitido — mostrando inicio y final ...]\n\n";

/**
 * Detects if the tail of a string contains important information (e.g. errors, summaries, exit status).
 */
export function hasImportantTail(text: string): boolean {
  if (text.length < 2000) return false;
  const tail = text.slice(-2000).toLowerCase();
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code|stderr)\b/.test(tail) ||
    /\}\s*$/.test(tail.trim()) || // JSON closing brackets
    /\]\s*$/.test(tail.trim()) || // JSON array closing
    /\b(total|summary|result|complete|finished|success|ok)\b/.test(tail)
  );
}

/**
 * Finds a clean cut point near the maxIndex, preferably at a newline.
 */
export function findCleanCut(text: string, maxIndex: number): number {
  if (maxIndex >= text.length) return text.length;
  // Look back up to 200 chars for a newline
  const lookback = Math.min(200, maxIndex);
  const searchSlice = text.slice(maxIndex - lookback, maxIndex);
  const lastNewline = searchSlice.lastIndexOf("\n");
  if (lastNewline !== -1) {
    return maxIndex - lookback + lastNewline;
  }
  return maxIndex;
}

/**
 * Finds a clean starting point for the tail, preferably at a newline.
 */
export function findCleanTailStart(text: string, tailBudget: number): number {
  const targetStart = text.length - tailBudget;
  if (targetStart <= 0) return 0;
  // Look forward up to 200 chars for a newline
  const lookforward = Math.min(200, text.length - targetStart);
  const searchSlice = text.slice(targetStart, targetStart + lookforward);
  const firstNewline = searchSlice.indexOf("\n");
  if (firstNewline !== -1) {
    return targetStart + firstNewline + 1;
  }
  return targetStart;
}

/**
 * Truncates a tool result, preserving a head and a tail portion if an error or important result is detected in the tail.
 */
export function truncateHeadTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const suffix = "\n[truncated: output exceeded context limit]";
  const budget = Math.max(2_000, maxChars - suffix.length);

  if (hasImportantTail(text) && budget > 4_000) {
    // Allocate 30% to tail, up to 4000 characters
    const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);
    const headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length;

    if (headBudget > 2_000) {
      const headCut = findCleanCut(text, headBudget);
      const tailStart = findCleanTailStart(text, tailBudget);
      
      // Ensure we don't overlap or create a weird slice
      if (headCut < tailStart) {
        return text.slice(0, headCut) + MIDDLE_OMISSION_MARKER + text.slice(tailStart) + suffix;
      }
    }
  }

  // Fallback to simple head truncation if tail isn't deemed important or budgets are too small
  const cut = findCleanCut(text, budget);
  return text.slice(0, cut) + suffix;
}

const MAX_SINGLE_TOOL_RESULT_SHARE = 0.30;

/**
 * Dynamically calculates character budget for a single tool result based on the model's context window.
 */
export function calculateToolResultBudget(contextWindowTokens: number): number {
  const maxTokens = Math.floor(contextWindowTokens * MAX_SINGLE_TOOL_RESULT_SHARE);
  return Math.min(maxTokens * 4, 400_000); // 4 chars/token approximation, capped at 400KB
}

/**
 * Enforces the budget on a single tool result content.
 */
export function enforceToolResultBudget(text: string, model: string, provider?: string): string {
  const budget = getContextBudget(model, provider);
  const charBudget = calculateToolResultBudget(budget.windowTokens);
  return truncateHeadTail(text, charBudget);
}
