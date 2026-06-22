import {
  getLocalContextBudget,
  isOllamaProvider,
  CLOUD_COMPACT_TRIGGER_RATIO,
  CLOUD_INPUT_HEADROOM_RATIO,
} from "../runtime/localMode.ts"

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
  "minimax-m3": 1_000_000,
  "minimax": 128_000,
  // Local models — conservative defaults; localMode.ts tightens further for 12GB VRAM
  "qwen": 8_192,
  "llama": 8_192,
  "gemma": 8_192,
  "mistral": 8_192,
  "phi": 8_192,
  "deepseek": 8_192,
  "lfm": 8_192,
  "gpt-oss": 131_072,
  // fallback
  "default": 128_000,
};

export function getContextBudget(model: string, provider?: string): {
  windowTokens: number;
  inputBudgetTokens: number;
  compactTriggerTokens: number;
} {
  if (isOllamaProvider(provider)) {
    return getLocalContextBudget(model)
  }

  const normalizedModel = model.toLowerCase();
  
  // Find match by substring
  let base = MODEL_CONTEXT_WINDOWS.default;
  for (const [key, windowSize] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (key !== "default" && normalizedModel.includes(key)) {
      base = windowSize;
      break;
    }
  }

  const inputBudget = Math.floor(base * CLOUD_INPUT_HEADROOM_RATIO);
  return {
    windowTokens: base,
    inputBudgetTokens: inputBudget,
    compactTriggerTokens: Math.floor(inputBudget * CLOUD_COMPACT_TRIGGER_RATIO),
  };
}
