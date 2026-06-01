const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-3-5-sonnet": 200_000,
  "claude-3-5-opus": 200_000,
  "claude-3": 200_000,
  "gpt-4o": 128_000,
  "gpt-4-turbo": 128_000,
  "gemini-2.5": 1_000_000,
  "gemini-1.5": 1_000_000,
  "gemini-": 1_000_000, // covers all gemini models
  "grok": 131_072,
  "kimi": 200_000,
  "minimax": 128_000,
  // fallback
  "default": 128_000,
};

const CONTEXT_INPUT_HEADROOM_RATIO = 0.75; // 75% of context window for inputs (leaving 25% for generation and tools)

export function getContextBudget(model: string): {
  windowTokens: number;
  inputBudgetTokens: number;
  compactTriggerTokens: number; // Trigger proactive compaction at 80% of input budget
} {
  const normalizedModel = model.toLowerCase();
  
  // Find match by substring
  let base = MODEL_CONTEXT_WINDOWS.default;
  for (const [key, windowSize] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (key !== "default" && normalizedModel.includes(key)) {
      base = windowSize;
      break;
    }
  }

  const inputBudget = Math.floor(base * CONTEXT_INPUT_HEADROOM_RATIO);
  return {
    windowTokens: base,
    inputBudgetTokens: inputBudget,
    compactTriggerTokens: Math.floor(inputBudget * 0.80),
  };
}
