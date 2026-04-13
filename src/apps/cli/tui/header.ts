import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { truncate } from "../../../core/renderer/toolRenderer.ts"
import { readModelSettings } from "../../../core/runtime/modelConfig.ts"
import { getActiveProfile } from "../../../core/runtime/modelRegistry.ts"
import type { HeaderState } from "./types.ts"

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

  // Prefer active profile from registry
  const activeProfile = getActiveProfile()
  if (activeProfile) {
    return {
      projectName: metadata.projectName,
      version: metadata.version,
      workspacePath: rootDir,
      model: activeProfile.model || "(unset)",
      provider: activeProfile.name || inferProvider(activeProfile.baseUrl),
      reasoning: "default",
      sessionId,
      connected,
    }
  }

  // Fallback to effective system settings when no profile is active
  const settings = readModelSettings()
  const model = settings.env.ANTHROPIC_MODEL.trim() || "(unset)"
  const baseUrl = settings.env.ANTHROPIC_BASE_URL.trim() || ""
  return {
    projectName: metadata.projectName,
    version: metadata.version,
    workspacePath: rootDir,
    model,
    provider: inferProvider(baseUrl),
    reasoning: "default",
    sessionId,
    connected,
  }
}
