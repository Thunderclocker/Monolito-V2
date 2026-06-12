import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { truncate } from "../../../core/renderer/toolRenderer.ts"
import { readModelSettings } from "../../../core/runtime/modelConfig.ts"
import { getActiveProfile, getDefaultReasoningLevel } from "../../../core/runtime/modelRegistry.ts"
import { getPaths } from "../../../core/ipc/protocol.ts"
import type { HeaderState } from "./types.ts"

const MINIMAX_TOKEN_CACHE_TTL = 30 * 60 * 1000 // 30 minutes

let minimaxTokenCache: { balance: string | null; timestamp: number } | null = null

type MinimaxTokenPlan = {
  success?: boolean
  base_info?: {
    plan_name?: string
    total_tokens?: number
    used_tokens?: number
    remaining_tokens?: number
    reset_date?: string
  }
  error?: string
}

async function fetchMinimaxTokenRemains(): Promise<string | null> {
  try {
    const activeProfile = getActiveProfile()
    const isMiniMax = activeProfile?.provider === "minimax" || activeProfile?.baseUrl?.toLowerCase().includes("minimax")
    if (!isMiniMax || !activeProfile?.apiKey) return null

    const res = await fetch("https://www.minimax.io/v1/token_plan/remains", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${activeProfile.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as MinimaxTokenPlan
    if (!data.success || !data.base_info) return null

    const { remaining_tokens, total_tokens, reset_date } = data.base_info
    if (remaining_tokens === undefined || total_tokens === undefined) return null

    const remaining = remaining_tokens >= 1_000_000
      ? `${(remaining_tokens / 1_000_000).toFixed(1)}M`
      : remaining_tokens >= 1_000
        ? `${(remaining_tokens / 1_000).toFixed(0)}K`
        : String(remaining_tokens)

    const total = total_tokens >= 1_000_000
      ? `${(total_tokens / 1_000_000).toFixed(1)}M`
      : total_tokens >= 1_000
        ? `${(total_tokens / 1_000).toFixed(0)}K`
        : String(total_tokens)

    const pct = total_tokens > 0 ? ((remaining_tokens / total_tokens) * 100).toFixed(1) : "0"

    let daysUntilReset = ""
    if (reset_date) {
      const ms = new Date(reset_date).getTime() - Date.now()
      const days = Math.ceil(ms / (24 * 60 * 60 * 1000))
      if (days > 0) daysUntilReset = ` │ reset in ${days}d`
      else if (days === 0) daysUntilReset = " │ resets today"
    }

    return `${remaining} / ${total} (${pct}%)${daysUntilReset}`
  } catch {
    return null
  }
}

function getMinimaxBalance(): string | null {
  const now = Date.now()
  if (minimaxTokenCache && now - minimaxTokenCache.timestamp < MINIMAX_TOKEN_CACHE_TTL) {
    return minimaxTokenCache.balance
  }
  // Fire and forget — update cache asynchronously, return stale or null
  fetchMinimaxTokenRemains().then(balance => {
    minimaxTokenCache = { balance, timestamp: Date.now() }
  })
  return minimaxTokenCache?.balance ?? null
}

export function inferProvider(baseUrl: string) {
  const normalized = baseUrl.trim().toLowerCase()
  if (!normalized) return "system/default"
  if (normalized.includes("minimax")) return "MiniMax"
  if (normalized.includes("localhost:11434") || normalized.includes("ollama")) return "Ollama"
  if (normalized.includes("openai")) return "OpenAI-compatible"
  if (normalized.includes("anthropic")) return "Anthropic-compatible"
  try {
    return new URL(baseUrl).host
  } catch {
    return truncate(baseUrl, 32)
  }
}

export function readProjectMetadata(rootDir: string) {
  try {
    const parsed = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as { name?: string; version?: string }
    return {
      projectName: parsed.name?.trim() || basename(rootDir),
      version: parsed.version?.trim() || "0.0.0",
    }
  } catch {
    return {
      projectName: basename(rootDir),
      version: "0.0.0",
    }
  }
}

export function getHeaderState(rootDir: string, sessionId: string, connected: boolean): HeaderState {
  const metadata = readProjectMetadata(rootDir)
  const workspacePath = getPaths(rootDir).workspaceDir
  const minimaxBalance = getMinimaxBalance()

  const activeProfile = getActiveProfile()
  if (activeProfile) {
    const defaultLevel = getDefaultReasoningLevel(activeProfile.provider, activeProfile.model)
    return {
      projectName: metadata.projectName,
      version: metadata.version,
      workspacePath,
      model: activeProfile.model || "(unset)",
      provider: activeProfile.name || inferProvider(activeProfile.baseUrl),
      reasoning: activeProfile.reasoningLevel ?? defaultLevel,
      sessionId,
      connected,
      minimaxBalance,
    }
  }

  const settings = readModelSettings()
  const model = settings.env.ANTHROPIC_MODEL.trim() || "(unset)"
  const baseUrl = settings.env.ANTHROPIC_BASE_URL.trim() || ""
  return {
    projectName: metadata.projectName,
    version: metadata.version,
    workspacePath,
    model,
    provider: inferProvider(baseUrl),
    reasoning: getDefaultReasoningLevel(baseUrl.includes("minimax") ? "minimax" : "anthropic_compatible", model),
    sessionId,
    connected,
    minimaxBalance,
  }
}

export function refreshMinimaxBalance() {
  minimaxTokenCache = null // force re-fetch on next render
  fetchMinimaxTokenRemains().then(balance => {
    minimaxTokenCache = { balance, timestamp: Date.now() }
  })
}
