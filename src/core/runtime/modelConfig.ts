import { getActiveProfile, type ModelProfile } from "./modelRegistry.ts"
import { createDefaultSystemConfig } from "../config/configWings.ts"
import { coerceConfigRecord } from "../config/wingValue.ts"
import { readConfigWing, writeConfigWing, appendActionLog } from "../session/store.ts"
import { MONOLITO_ROOT } from "../system/root.ts"
import { MODEL_PROTOCOL } from "./modelConstants.ts"

export type ModelSettings = {
  modelConfig: {
    protocol: string
  }
  env: {
    ANTHROPIC_BASE_URL: string
    ANTHROPIC_AUTH_TOKEN: string
    ANTHROPIC_MODEL: string
    API_TIMEOUT_MS: string
    MAX_BUDGET_USD: string
  }
}

export type ModelDraft = {
  protocol: string
  baseUrl: string
  apiKey: string
  model: string
  maxBudgetUsd?: string
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value : ""
}

export function getSettingsPath() {
  return `${MONOLITO_ROOT}/CONF_SYSTEM`
}

export function createDefaultSettings(): ModelSettings {
  const defaults = createDefaultSystemConfig()
  return {
    modelConfig: {
      protocol: MODEL_PROTOCOL,
    },
    env: {
      ANTHROPIC_BASE_URL: defaults.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: defaults.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_MODEL: defaults.env.ANTHROPIC_MODEL,
      API_TIMEOUT_MS: defaults.env.API_TIMEOUT_MS,
      MAX_BUDGET_USD: defaults.env.MAX_BUDGET_USD,
    },
  }
}

export function readModelSettings(): ModelSettings {
  const defaults = createDefaultSettings()
  const raw = coerceConfigRecord(readConfigWing(MONOLITO_ROOT, "CONF_SYSTEM")) as Partial<ModelSettings> | null
  return {
    modelConfig: {
      protocol: normalizeString(raw?.modelConfig?.protocol) || defaults.modelConfig.protocol,
    },
    env: {
      ANTHROPIC_BASE_URL: normalizeString(raw?.env?.ANTHROPIC_BASE_URL) || defaults.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: normalizeString(raw?.env?.ANTHROPIC_AUTH_TOKEN) || defaults.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_MODEL: normalizeString(raw?.env?.ANTHROPIC_MODEL) || defaults.env.ANTHROPIC_MODEL,
      API_TIMEOUT_MS: normalizeString(raw?.env?.API_TIMEOUT_MS) || defaults.env.API_TIMEOUT_MS,
      MAX_BUDGET_USD: normalizeString(raw?.env?.MAX_BUDGET_USD) || defaults.env.MAX_BUDGET_USD,
    },
  }
}

export function settingsToDraft(settings: ModelSettings): ModelDraft {
  return {
    protocol: settings.modelConfig.protocol,
    baseUrl: settings.env.ANTHROPIC_BASE_URL,
    apiKey: settings.env.ANTHROPIC_AUTH_TOKEN,
    model: settings.env.ANTHROPIC_MODEL,
    maxBudgetUsd: settings.env.MAX_BUDGET_USD,
  }
}

export function draftToSettings(draft: ModelDraft): ModelSettings {
  const defaults = createDefaultSettings()
  return {
    modelConfig: {
      protocol: MODEL_PROTOCOL,
    },
    env: {
      ANTHROPIC_BASE_URL: draft.baseUrl.trim(),
      ANTHROPIC_AUTH_TOKEN: draft.apiKey.trim(),
      ANTHROPIC_MODEL: draft.model.trim(),
      API_TIMEOUT_MS: defaults.env.API_TIMEOUT_MS,
      MAX_BUDGET_USD: (draft.maxBudgetUsd || "0").trim(),
    },
  }
}

export function validateModelDraft(draft: ModelDraft) {
  const errors: string[] = []
  if ((draft.protocol || "").trim() !== MODEL_PROTOCOL) {
    errors.push(`Protocol must be ${MODEL_PROTOCOL}`)
  }
  if (!(draft.model || "").trim()) {
    errors.push("Model is required")
  }
  if (!(draft.apiKey || "").trim()) {
    errors.push("API key is required")
  }
  return errors
}

export function saveModelSettings(settings: ModelSettings) {
  writeConfigWing(MONOLITO_ROOT, "CONF_SYSTEM", settings)
  appendActionLog(MONOLITO_ROOT, "Cambio de configuracion del sistema", {
    wing: "CONF_SYSTEM",
    model: settings.env.ANTHROPIC_MODEL,
    baseUrl: settings.env.ANTHROPIC_BASE_URL,
  })
}

/**
 * Bootstrap CONF_MODELS and CONF_SYSTEM wings from process.env on first run.
 *
 * Background: `loadEnvFile` populates process.env from the user's .env file,
 * but the runtime source of truth for model config is the SQLite CONF_MODELS
 * and CONF_SYSTEM wings. Without this bridge, a fresh installation starts
 * with empty wings, and any model call lands on the Anthropic SDK default
 * with an empty apiKey — which produces a 401 from api.anthropic.com.
 *
 * This runs only when CONF_MODELS has no profiles AND the env has at least
 * an auth token. It infers the provider from the base URL (matching
 * inferProviderFromUrl in modelRegistry) and writes one active profile.
 *
 * Idempotent: if a profile already exists, this is a no-op.
 */
export async function bootstrapConfigFromEnv(env: NodeJS.ProcessEnv = process.env) {
  try {
    const existing = readModelSettings()
    const hasUsableEnv = Boolean(
      (env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_AUTH_TOKEN.trim()) ||
      (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL.trim()),
    )
    if (!hasUsableEnv) return

    const baseUrl = (env.ANTHROPIC_BASE_URL ?? existing.env.ANTHROPIC_BASE_URL ?? "").trim()
    const authToken = (env.ANTHROPIC_AUTH_TOKEN ?? existing.env.ANTHROPIC_AUTH_TOKEN ?? "").trim()
    const model = (env.ANTHROPIC_MODEL ?? existing.env.ANTHROPIC_MODEL ?? "").trim()
    const apiTimeout = (env.API_TIMEOUT_MS ?? existing.env.API_TIMEOUT_MS ?? "3000000").trim()
    const maxBudget = (env.MAX_BUDGET_USD ?? existing.env.MAX_BUDGET_USD ?? "0").trim()

    const settings: ModelSettings = {
      modelConfig: { protocol: "anthropic_compatible" },
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: authToken,
        ANTHROPIC_MODEL: model,
        API_TIMEOUT_MS: apiTimeout,
        MAX_BUDGET_USD: maxBudget,
      },
    }
    saveModelSettings(settings)

    // Also create a default profile in CONF_MODELS so getActiveProfile()
    // returns something useful on first run.
    try {
      const { listProfiles, addProfile } = await import("./modelRegistry.ts")
      const existingProfiles = listProfiles()
      if (existingProfiles.length === 0 && baseUrl && authToken) {
        const lowerUrl = baseUrl.toLowerCase()
        let provider: "minimax" | "ollama" | "openai_compatible" | "anthropic_compatible" = "anthropic_compatible"
        if (lowerUrl.includes("minimax")) provider = "minimax"
        else if (lowerUrl.includes("localhost:11434") || lowerUrl.includes("ollama")) provider = "ollama"
        else if (lowerUrl.includes("openai")) provider = "openai_compatible"
        addProfile({
          provider,
          baseUrl,
          apiKey: authToken,
          model: model || "claude-3-5-sonnet-latest",
        })
      }
    } catch (profileErr) {
      // If the profile write fails, the env settings alone are still useful.
      console.error(`[bootstrapConfigFromEnv] failed to create default profile:`, profileErr)
    }

    appendActionLog(MONOLITO_ROOT, "Bootstrap de configuracion inicial desde .env", {
      wing: "CONF_SYSTEM",
      model: model || "(unset)",
      baseUrl: baseUrl || "(unset)",
    })
  } catch (err) {
    console.error(`[bootstrapConfigFromEnv] failed:`, err)
  }
}

export function maskApiKey(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return "Not set"
  const visible = trimmed.slice(-4)
  return `${"*".repeat(Math.max(8, trimmed.length - Math.min(trimmed.length, 4)))}${visible}`
}

export function redactSensitiveModelSettings(settings: ModelSettings) {
  return {
    modelConfig: settings.modelConfig,
    env: {
      ...settings.env,
      ANTHROPIC_AUTH_TOKEN: maskApiKey(settings.env.ANTHROPIC_AUTH_TOKEN),
    },
  }
}

export function applyModelSettingsToEnv(env: NodeJS.ProcessEnv, settings: ModelSettings) {
  env.ANTHROPIC_BASE_URL = settings.env.ANTHROPIC_BASE_URL.trim()
  env.ANTHROPIC_AUTH_TOKEN = settings.env.ANTHROPIC_AUTH_TOKEN.trim()
  env.ANTHROPIC_API_KEY = settings.env.ANTHROPIC_AUTH_TOKEN.trim()
  env.ANTHROPIC_MODEL = settings.env.ANTHROPIC_MODEL.trim()
  env.API_TIMEOUT_MS = settings.env.API_TIMEOUT_MS
  env.MAX_BUDGET_USD = settings.env.MAX_BUDGET_USD
  delete env.MONOLITO_ACTIVE_PROVIDER
  return env
}

export function refreshModelAuth(env: NodeJS.ProcessEnv = process.env) {
  const settings = readModelSettings()
  return applyModelSettingsToEnv(env, settings)
}

export function applyProfileToEnv(env: NodeJS.ProcessEnv, profile: ModelProfile) {
  env.ANTHROPIC_BASE_URL = profile.baseUrl.trim()
  env.ANTHROPIC_AUTH_TOKEN = profile.apiKey.trim()
  env.ANTHROPIC_API_KEY = profile.apiKey.trim()
  env.ANTHROPIC_MODEL = profile.model.trim()
  env.MONOLITO_ACTIVE_PROVIDER = profile.provider
  return env
}

export function loadAndApplyModelSettings(env: NodeJS.ProcessEnv = process.env) {
  const activeProfile = getActiveProfile()
  if (activeProfile) {
    applyProfileToEnv(env, activeProfile)
    return readModelSettings()
  }
  const settings = readModelSettings()
  applyModelSettingsToEnv(env, settings)
  return settings
}
