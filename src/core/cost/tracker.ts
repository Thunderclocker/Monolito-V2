/**
 * Cost tracking for Monolito V2 sessions.
 * Tracks token usage, API duration, tool duration, and estimated USD cost.
 */

export type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  apiCalls: number
}

export type CostState = {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadInputTokens: number
  totalCacheCreationInputTokens: number
  totalApiDurationMs: number
  totalToolDurationMs: number
  totalCostUSD: number
  apiCalls: number
  toolCalls: number
  modelUsage: Record<string, ModelUsage>
  sessionStartedAt: string
  lastUpdatedAt: string
}

type PricingEntry = {
  inputPerMToken: number
  outputPerMToken: number
  cacheReadPerMToken: number
  cacheCreationPerMToken: number
}

const DEFAULT_PRICING: PricingEntry = {
  inputPerMToken: 3.0,
  outputPerMToken: 15.0,
  cacheReadPerMToken: 0.3,
  cacheCreationPerMToken: 3.75,
}

const KNOWN_PRICING: Record<string, PricingEntry> = {
  "claude-opus-4-20250514": { inputPerMToken: 15.0, outputPerMToken: 75.0, cacheReadPerMToken: 1.5, cacheCreationPerMToken: 18.75 },
  "claude-sonnet-4-20250514": { inputPerMToken: 3.0, outputPerMToken: 15.0, cacheReadPerMToken: 0.3, cacheCreationPerMToken: 3.75 },
  "claude-3-5-sonnet-20241022": { inputPerMToken: 3.0, outputPerMToken: 15.0, cacheReadPerMToken: 0.3, cacheCreationPerMToken: 3.75 },
  "claude-3-5-haiku-20241022": { inputPerMToken: 0.8, outputPerMToken: 4.0, cacheReadPerMToken: 0.08, cacheCreationPerMToken: 1.0 },
}

function getPricing(model: string): PricingEntry {
  const normalized = model.toLowerCase().trim()
  for (const [key, pricing] of Object.entries(KNOWN_PRICING)) {
    if (normalized.includes(key) || normalized.startsWith(key.split("-").slice(0, 3).join("-"))) {
      return pricing
    }
  }
  if (normalized.includes("opus")) return KNOWN_PRICING["claude-opus-4-20250514"]!
  if (normalized.includes("haiku")) return KNOWN_PRICING["claude-3-5-haiku-20241022"]!
  return DEFAULT_PRICING
}

function calculateCost(usage: ModelUsage, model: string): number {
  const pricing = getPricing(model)
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerMToken +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMToken +
    (usage.cacheReadInputTokens / 1_000_000) * pricing.cacheReadPerMToken +
    (usage.cacheCreationInputTokens / 1_000_000) * pricing.cacheCreationPerMToken
  )
}

export function estimateTurnCostUSD(model: string, usage: TurnUsage): number {
  return calculateCost(
    {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      apiCalls: 1,
    },
    model,
  )
}

export function createCostState(): CostState {
  const now = new Date().toISOString()
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadInputTokens: 0,
    totalCacheCreationInputTokens: 0,
    totalApiDurationMs: 0,
    totalToolDurationMs: 0,
    totalCostUSD: 0,
    apiCalls: 0,
    toolCalls: 0,
    modelUsage: {},
    sessionStartedAt: now,
    lastUpdatedAt: now,
  }
}

export type TurnUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

export function recordApiCall(state: CostState, model: string, usage: TurnUsage, durationMs: number) {
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheCreation = usage.cacheCreationInputTokens ?? 0

  state.totalInputTokens += inputTokens
  state.totalOutputTokens += outputTokens
  state.totalCacheReadInputTokens += cacheRead
  state.totalCacheCreationInputTokens += cacheCreation
  state.totalApiDurationMs += durationMs
  state.apiCalls += 1

  const existing = state.modelUsage[model] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    apiCalls: 0,
  }
  existing.inputTokens += inputTokens
  existing.outputTokens += outputTokens
  existing.cacheReadInputTokens += cacheRead
  existing.cacheCreationInputTokens += cacheCreation
  existing.apiCalls += 1
  state.modelUsage[model] = existing

  state.totalCostUSD += calculateCost(
    { inputTokens, outputTokens, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation, apiCalls: 1 },
    model,
  )
  state.lastUpdatedAt = new Date().toISOString()
}

export function recordToolCall(state: CostState, durationMs: number) {
  state.totalToolDurationMs += durationMs
  state.toolCalls += 1
  state.lastUpdatedAt = new Date().toISOString()
}

export function formatCostUSD(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(2)}M`
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

export function formatCostSummary(state: CostState): string {
  const lines: string[] = [
    `Cost: ${formatCostUSD(state.totalCostUSD)}`,
    `Tokens: ${formatTokenCount(state.totalInputTokens)} in / ${formatTokenCount(state.totalOutputTokens)} out`,
  ]
  if (state.totalCacheReadInputTokens > 0 || state.totalCacheCreationInputTokens > 0) {
    lines.push(`Cache: ${formatTokenCount(state.totalCacheReadInputTokens)} read / ${formatTokenCount(state.totalCacheCreationInputTokens)} created`)
  }
  lines.push(`API: ${state.apiCalls} calls · ${formatDurationMs(state.totalApiDurationMs)}`)
  if (state.toolCalls > 0) {
    lines.push(`Tools: ${state.toolCalls} calls · ${formatDurationMs(state.totalToolDurationMs)}`)
  }
  if (Object.keys(state.modelUsage).length > 1) {
    lines.push("", "Per model:")
    for (const [model, usage] of Object.entries(state.modelUsage)) {
      const modelCost = calculateCost(usage, model)
      lines.push(`  ${model}: ${formatCostUSD(modelCost)} · ${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out · ${usage.apiCalls} calls`)
    }
  }
  return lines.join("\n")
}

export function costStateToSessionData(state: CostState) {
  return {
    costUSD: state.totalCostUSD,
    inputTokens: state.totalInputTokens,
    outputTokens: state.totalOutputTokens,
    cacheReadTokens: state.totalCacheReadInputTokens,
    cacheCreationTokens: state.totalCacheCreationInputTokens,
    apiCalls: state.apiCalls,
    toolCalls: state.toolCalls,
    apiDurationMs: state.totalApiDurationMs,
    toolDurationMs: state.totalToolDurationMs,
  }
}
