/**
 * Monolito V2 local execution support (Ollama-only dynamic num_ctx, keep_alive, VRAM).
 */

import {
  getCachedOllamaModelContext,
  refreshOllamaModelContext,
  type OllamaModelContextInfo,
} from "./localModelContext.ts"

/** Unified input/compact ratios for Ollama (small VRAM windows). */
export const RUNTIME_INPUT_HEADROOM_RATIO = 0.65
export const RUNTIME_COMPACT_TRIGGER_RATIO = 0.75

/** Cloud providers use the full model window without local-style tightening. */
export const CLOUD_INPUT_HEADROOM_RATIO = 0.75
export const CLOUD_COMPACT_TRIGGER_RATIO = 0.80

/** Per-model num_ctx tuned for 12GB / 8GB / fallback tiers (Ollama only). */
const CONTEXT_BY_VRAM_TIER: Record<"12gb" | "8gb" | "default", Record<string, number>> = {
  "12gb": {
    gemma: 32_768,
    qwen: 16_384,
    lfm: 16_384,
    llama: 16_384,
    mistral: 12_288,
    phi: 12_288,
    deepseek: 12_288,
    default: 8_192,
  },
  "8gb": {
    gemma: 16_384,
    qwen: 8_192,
    lfm: 8_192,
    llama: 8_192,
    mistral: 8_192,
    phi: 8_192,
    deepseek: 8_192,
    default: 8_192,
  },
  default: {
    gemma: 8_192,
    qwen: 8_192,
    lfm: 8_192,
    llama: 8_192,
    mistral: 8_192,
    phi: 8_192,
    deepseek: 8_192,
    default: 8_192,
  },
}

const LOCAL_MODEL_KEYS = ["qwen", "llama", "gemma", "mistral", "phi", "deepseek", "lfm"]

function envFlag(name: string): boolean {
  const value = (process.env[name] ?? "").trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes"
}

function getVramTier(): keyof typeof CONTEXT_BY_VRAM_TIER {
  const mb = Number.parseInt(process.env.MONOLITO_GPU_VRAM_MB ?? "", 10)
  if (Number.isFinite(mb) && mb >= 11_000) return "12gb"
  if (Number.isFinite(mb) && mb >= 7_000) return "8gb"
  return "default"
}

function modelFamily(model: string): string {
  const normalized = model.toLowerCase()
  for (const key of LOCAL_MODEL_KEYS) {
    if (normalized.includes(key)) return key
  }
  return "default"
}

function readPerModelEnvOverride(model: string): number | undefined {
  const family = modelFamily(model)
  const envKey = `MONOLITO_LOCAL_CTX_${family.toUpperCase()}`
  const parsed = Number.parseInt(process.env[envKey] ?? "", 10)
  if (Number.isFinite(parsed) && parsed >= 2048) return parsed
  return undefined
}

/** Ollama-only runtime tuning (dynamic num_ctx, keep_alive, VRAM unload). */
export function isOllamaProvider(provider?: string): boolean {
  return (provider ?? "").toLowerCase() === "ollama"
}

/** @deprecated Use isOllamaProvider — kept for call-site compatibility. */
export function isLocalModeEnabled(provider?: string): boolean {
  return isOllamaProvider(provider)
}

function getStaticLocalNumCtx(model: string): number {
  const tier = getVramTier()
  const family = modelFamily(model)
  return CONTEXT_BY_VRAM_TIER[tier][family] ?? CONTEXT_BY_VRAM_TIER[tier].default
}

export function getLocalNumCtx(model: string): number {
  const perModel = readPerModelEnvOverride(model)
  if (perModel !== undefined) return perModel

  const globalOverride = Number.parseInt(process.env.MONOLITO_LOCAL_NUM_CTX ?? "", 10)
  if (Number.isFinite(globalOverride) && globalOverride >= 2048) return globalOverride

  const cached = getCachedOllamaModelContext(model)
  if (cached?.computedNumCtx) return cached.computedNumCtx

  return getStaticLocalNumCtx(model)
}

/** Query Ollama /api/show and cache a VRAM-aware num_ctx for the model tag. */
export async function preloadLocalModelContext(
  model: string,
  baseUrl = "http://127.0.0.1:11434",
): Promise<OllamaModelContextInfo | null> {
  const family = modelFamily(model)
  const tier = getVramTier()
  const familyCeiling = CONTEXT_BY_VRAM_TIER[tier][family] ?? CONTEXT_BY_VRAM_TIER[tier].default
  const ceiling = family === "default"
    ? undefined
    : familyCeiling
  return refreshOllamaModelContext(model, baseUrl, ceiling)
}

export { refreshOllamaModelContext, getCachedOllamaModelContext } from "./localModelContext.ts"

export function scheduleLocalModelContextPreload(model: string, baseUrl?: string): void {
  const tag = model.trim()
  if (!tag) return
  if (getCachedOllamaModelContext(tag)) return
  void preloadLocalModelContext(tag, baseUrl).catch(() => {})
}

export function getLocalContextBudget(model: string): {
  windowTokens: number
  inputBudgetTokens: number
  compactTriggerTokens: number
} {
  const base = getLocalNumCtx(model)
  const inputBudget = Math.floor(base * RUNTIME_INPUT_HEADROOM_RATIO)
  return {
    windowTokens: base,
    inputBudgetTokens: inputBudget,
    compactTriggerTokens: Math.floor(inputBudget * RUNTIME_COMPACT_TRIGGER_RATIO),
  }
}

export function getLocalOllamaOptions(model: string): Record<string, number> {
  const numCtx = getLocalNumCtx(model)
  const numPredict = Number.parseInt(process.env.MONOLITO_LOCAL_NUM_PREDICT ?? "2048", 10)
  return {
    num_ctx: numCtx,
    num_predict: Number.isFinite(numPredict) ? numPredict : 2048,
    temperature: 0.6,
  }
}

export function getLocalOllamaKeepAlive(): string {
  const override = (process.env.MONOLITO_OLLAMA_KEEP_ALIVE ?? "").trim()
  if (override) return override
  return "30m"
}

export function getMemoryAgentBatchBudgetFraction(provider?: string): number {
  const override = Number.parseFloat(process.env.MONOLITO_MEMORY_AGENT_BATCH_FRACTION ?? "")
  if (Number.isFinite(override) && override > 0 && override <= 1) return override
  return isOllamaProvider(provider) ? 0.3 : 0.65
}

export function getMemoryAgentMemorySummaryLimit(provider?: string): number {
  return isOllamaProvider(provider) ? 3 : 8
}

export function getKeywordRecallLimits(provider?: string): {
  historySnippets: number
  memorySections: number
  messageTail: number
  fallbackTail: number
} {
  if (isOllamaProvider(provider)) {
    return { historySnippets: 3, memorySections: 1, messageTail: 4, fallbackTail: 6 }
  }
  return { historySnippets: 12, memorySections: 3, messageTail: 8, fallbackTail: 12 }
}

export function getLocalVramSummary(): { tier: string; vramMb: number | null; contexts: Record<string, number> } {
  const vramMb = Number.parseInt(process.env.MONOLITO_GPU_VRAM_MB ?? "", 10)
  const tier = getVramTier()
  const contexts: Record<string, number> = {}
  for (const key of [...LOCAL_MODEL_KEYS, "default"]) {
    contexts[key] = CONTEXT_BY_VRAM_TIER[tier][key] ?? CONTEXT_BY_VRAM_TIER[tier].default
  }
  return {
    tier,
    vramMb: Number.isFinite(vramMb) ? vramMb : null,
    contexts,
  }
}
