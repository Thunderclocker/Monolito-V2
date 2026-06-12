import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { truncate } from "../../../core/renderer/toolRenderer.ts"
import { readModelSettings } from "../../../core/runtime/modelConfig.ts"
import { getActiveProfile, getDefaultReasoningLevel } from "../../../core/runtime/modelRegistry.ts"
import { getPaths } from "../../../core/ipc/protocol.ts"
import type { HeaderState } from "./types.ts"

const MINIMAX_TOKEN_CACHE_TTL = 30 * 60 * 1000 // 30 minutes

let minimaxTokenCache: { balance: string | null; timestamp: number } | null = null

type MinimaxTokenPlanInterval = {
  model_name: string
  start_time: number
  end_time: number
  current_interval_total_count: number
  current_interval_usage_count: number
  current_interval_remaining_percent: number
  current_interval_status: number
}

type MinimaxTokenPlanResponse = {
  model_remains: MinimaxTokenPlanInterval[]
  base_resp?: {
    status_code: number
    status_msg?: string
  }
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function formatDaysUntil(msTimestamp: number): string {
  const ms = msTimestamp - Date.now()
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000))
  if (days > 1) return ` │ reset in ${days}d`
  if (days === 1) return " │ reset in 1d"
  if (days === 0) return " │ resets today"
  return ""
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
    const data = (await res.json()) as MinimaxTokenPlanResponse
    if (data.base_resp && data.base_resp.status_code !== 0) return null
    if (!data.model_remains?.length) return null

    // Prefer "general" model, fallback to first entry
    const entry = data.model_remains.find(m => m.model_name === "general") ?? data.model_remains[0]
    const pct = entry.current_interval_remaining_percent
    const reset = formatDaysUntil(entry.end_time)

    // Show token counts if available (some plans report usage)
    if (entry.current_interval_total_count > 0) {
      const used = entry.current_interval_usage_count
      const total = entry.current_interval_total_count
      const remaining = total - used
      return `${formatCount(remaining)} / ${formatCount(total)} (${pct}%)${reset}`
    }

    // Time-based plan: show percent only
    return `${pct}% remaining${reset}`
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
