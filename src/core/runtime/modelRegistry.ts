import { randomUUID } from "node:crypto"
import { readModelSettings, maskApiKey } from "./modelConfig.ts"
import { appendActionLog, readConfigWing, writeConfigWing } from "../session/store.ts"
import { MONOLITO_ROOT } from "../system/root.ts"
import { coerceConfigRecord } from "../config/wingValue.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelProvider = "minimax" | "ollama" | "openai_compatible" | "anthropic_compatible"

export type ModelProfile = {
  id: string
  name: string
  provider: ModelProvider
  baseUrl: string
  apiKey: string
  model: string
  active: boolean
}

export type ModelProfileDraft = {
  name?: string
  provider: ModelProvider
  baseUrl?: string
  apiKey?: string
  model: string
}

export type ModelRegistry = {
  version: 1
  profiles: ModelProfile[]
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getRegistryPath() {
  return `${MONOLITO_ROOT}/CONF_MODELS`
}

// ---------------------------------------------------------------------------
// Provider defaults
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULTS: Record<ModelProvider, { baseUrl: string; needsApiKey: boolean }> = {
  minimax: { baseUrl: "https://api.minimax.chat", needsApiKey: true },
  ollama: { baseUrl: "http://localhost:11434", needsApiKey: false },
  openai_compatible: { baseUrl: "https://api.openai.com", needsApiKey: true },
  anthropic_compatible: { baseUrl: "", needsApiKey: true },
}

export function getProviderDefaults(provider: ModelProvider) {
  return PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic_compatible
}

export function getAvailableProviders(): ModelProvider[] {
  return ["openai_compatible", "anthropic_compatible", "ollama", "minimax"]
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function createEmptyRegistry(): ModelRegistry {
  return { version: 1, profiles: [] }
}

export function readRegistry(): ModelRegistry {
  const raw = coerceConfigRecord(readConfigWing(process.cwd(), "CONF_MODELS")) as Partial<ModelRegistry> | null
  try {
    if (!raw || !Array.isArray(raw.profiles)) return createEmptyRegistry()
    return {
      version: 1,
      profiles: raw.profiles.map(normalizeProfile).filter(Boolean) as ModelProfile[],
    }
  } catch {
    return createEmptyRegistry()
  }
}

export function saveRegistry(registry: ModelRegistry) {
  writeConfigWing(process.cwd(), "CONF_MODELS", registry)
}

function normalizeProfile(raw: unknown): ModelProfile | null {
  if (!raw || typeof raw !== "object") return null
  const profile = raw as Record<string, unknown>
  const id = typeof profile.id === "string" ? profile.id : ""
  const name = typeof profile.name === "string" ? profile.name : ""
  const provider = typeof profile.provider === "string" ? profile.provider as ModelProvider : "anthropic_compatible"
  const baseUrl = typeof profile.baseUrl === "string" ? profile.baseUrl : ""
  const apiKey = typeof profile.apiKey === "string" ? profile.apiKey : ""
  const model = typeof profile.model === "string" ? profile.model : ""
  const active = typeof profile.active === "boolean" ? profile.active : false
  if (!id || !model) return null
  return { id, name: name || model, provider, baseUrl, apiKey, model, active }
}

function inferProviderFromUrl(baseUrl: string): ModelProvider {
  const normalized = baseUrl.toLowerCase()
  if (normalized.includes("minimax")) return "minimax"
  if (normalized.includes("localhost:11434") || normalized.includes("ollama")) return "ollama"
  if (normalized.includes("openai")) return "openai_compatible"
  return "anthropic_compatible"
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export function listProfiles(): ModelProfile[] {
  return readRegistry().profiles
}

export function getActiveProfile(): ModelProfile | null {
  const registry = readRegistry()
  return registry.profiles.find(p => p.active) ?? registry.profiles[0] ?? null
}

export function getProfileById(id: string): ModelProfile | null {
  return readRegistry().profiles.find(p => p.id === id) ?? null
}

export function getProfileByIndex(index: number): ModelProfile | null {
  const profiles = readRegistry().profiles
  return profiles[index] ?? null
}

export function addProfile(draft: ModelProfileDraft): ModelProfile {
  const registry = readRegistry()
  const defaults = getProviderDefaults(draft.provider)
  const isFirst = registry.profiles.length === 0
  const profile: ModelProfile = {
    id: randomUUID(),
    name: draft.name?.trim() || draft.model,
    provider: draft.provider,
    baseUrl: (draft.baseUrl?.trim() || defaults.baseUrl).replace(/\/+$/, ""),
    apiKey: draft.apiKey?.trim() ?? "",
    model: draft.model.trim(),
    active: isFirst, // first profile is auto-activated
  }
  registry.profiles.push(profile)
  saveRegistry(registry)
  appendActionLog(process.cwd(), "Perfil de modelo creado", {
    profileId: profile.id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
  })
  return profile
}

export function updateProfile(id: string, draft: Partial<ModelProfileDraft>): ModelProfile {
  const registry = readRegistry()
  const index = registry.profiles.findIndex(p => p.id === id)
  if (index === -1) throw new Error(`Profile not found: ${id}`)
  const existing = registry.profiles[index]!
  const updated: ModelProfile = {
    ...existing,
    name: draft.name?.trim() ?? existing.name,
    provider: draft.provider ?? existing.provider,
    baseUrl: draft.baseUrl !== undefined ? draft.baseUrl.trim().replace(/\/+$/, "") : existing.baseUrl,
    apiKey: draft.apiKey !== undefined ? draft.apiKey.trim() : existing.apiKey,
    model: draft.model?.trim() ?? existing.model,
  }
  registry.profiles[index] = updated
  saveRegistry(registry)
  appendActionLog(process.cwd(), "Perfil de modelo actualizado", {
    profileId: updated.id,
    name: updated.name,
    provider: updated.provider,
    model: updated.model,
  })
  return updated
}

export function deleteProfile(id: string): string {
  const registry = readRegistry()
  const index = registry.profiles.findIndex(p => p.id === id)
  if (index === -1) throw new Error(`Profile not found: ${id}`)
  const removed = registry.profiles[index]!
  const wasActive = removed.active
  registry.profiles.splice(index, 1)
  // If we deleted the active profile, activate the first remaining one
  if (wasActive && registry.profiles.length > 0) {
    registry.profiles[0]!.active = true
  }
  saveRegistry(registry)
  appendActionLog(process.cwd(), "Perfil de modelo eliminado", {
    profileId: removed.id,
    name: removed.name,
  })
  return removed.name
}

export function activateProfile(id: string): ModelProfile {
  const registry = readRegistry()
  const target = registry.profiles.find(p => p.id === id)
  if (!target) throw new Error(`Profile not found: ${id}`)
  for (const profile of registry.profiles) {
    profile.active = profile.id === id
  }
  saveRegistry(registry)
  appendActionLog(process.cwd(), "Cambio de modelo exitoso", {
    profileId: target.id,
    name: target.name,
    provider: target.provider,
    model: target.model,
  })
  return target
}

export function activateProfileByIndex(index: number): ModelProfile {
  const registry = readRegistry()
  const target = registry.profiles[index]
  if (!target) throw new Error(`Profile #${index + 1} not found`)
  for (const profile of registry.profiles) {
    profile.active = profile.id === target.id
  }
  saveRegistry(registry)
  appendActionLog(process.cwd(), "Cambio de modelo exitoso", {
    profileId: target.id,
    name: target.name,
    provider: target.provider,
    model: target.model,
  })
  return target
}

// ---------------------------------------------------------------------------
// Ollama discovery
// ---------------------------------------------------------------------------

export async function discoverOllamaModels(baseUrl?: string): Promise<string[]> {
  const url = (baseUrl?.trim() || "http://localhost:11434").replace(/\/+$/, "")
  try {
    const response = await fetch(`${url}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return []
    const data = await response.json() as { models?: Array<{ name?: string; model?: string }> }
    if (!Array.isArray(data.models)) return []
    return data.models
      .map(m => (m.name ?? m.model ?? "").trim())
      .filter(Boolean)
      .sort()
  } catch {
    return []
  }
}

export async function addOllamaDiscoveredModels(baseUrl?: string): Promise<ModelProfile[]> {
  const url = (baseUrl?.trim() || "http://localhost:11434").replace(/\/+$/, "")
  const models = await discoverOllamaModels(url)
  if (models.length === 0) return []
  const registry = readRegistry()
  const existingOllamaModels = new Set(
    registry.profiles
      .filter(p => p.provider === "ollama")
      .map(p => p.model),
  )
  const added: ModelProfile[] = []
  for (const model of models) {
    if (existingOllamaModels.has(model)) continue
    const profile: ModelProfile = {
      id: randomUUID(),
      name: `Ollama ${model}`,
      provider: "ollama",
      baseUrl: url,
      apiKey: "",
      model,
      active: false,
    }
    registry.profiles.push(profile)
    added.push(profile)
  }
  if (added.length > 0) {
    // If no active profile, activate the first Ollama one
    if (!registry.profiles.some(p => p.active) && added[0]) {
      added[0].active = true
      const idx = registry.profiles.findIndex(p => p.id === added[0]!.id)
      if (idx >= 0) registry.profiles[idx]!.active = true
    }
    saveRegistry(registry)
  }
  return added
}

// ---------------------------------------------------------------------------
// Utility: redact a profile for display
// ---------------------------------------------------------------------------

export function redactProfile(profile: ModelProfile): ModelProfile & { apiKey: string } {
  return { ...profile, apiKey: maskApiKey(profile.apiKey) }
}
