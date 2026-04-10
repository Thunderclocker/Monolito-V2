import { getActiveProfile, type ModelProfile } from "./modelRegistry.ts"
import { createDefaultSystemConfig } from "../config/configWings.ts"
import { readConfigWing, writeConfigWing, appendActionLog } from "../session/store.ts"
import { MONOLITO_ROOT } from "../system/root.ts"

export const MODEL_PROTOCOL = "anthropic_compatible"
export const SYSTEM_AUTH_TOKEN_ENV = "MONOLITO_V2_SYSTEM_ANTHROPIC_AUTH_TOKEN"
export const SYSTEM_BASE_URL_ENV = "MONOLITO_V2_SYSTEM_ANTHROPIC_BASE_URL"
export const SYSTEM_MODEL_ENV = "MONOLITO_V2_SYSTEM_ANTHROPIC_MODEL"

export type ModelSettings = {
  modelConfig: {
    protocol: string
  }
  env: {
    ANTHROPIC_BASE_URL: string
    ANTHROPIC_AUTH_TOKEN: string
    ANTHROPIC_MODEL: string
    API_TIMEOUT_MS: string
  }
}

export type ModelDraft = {
  protocol: string
  baseUrl: string
  apiKey: string
  model: string
}

type ReadSettingsOptions = {
  env?: NodeJS.ProcessEnv
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value : ""
}

function getSystemValue(env: NodeJS.ProcessEnv, preservedKey: string, liveKey: string) {
  if (Object.prototype.hasOwnProperty.call(env, preservedKey)) {
    return typeof env[preservedKey] === "string" ? env[preservedKey] ?? "" : ""
  }
  return typeof env[liveKey] === "string" ? env[liveKey] ?? "" : ""
}

export function getSettingsPath() {
  return `${MONOLITO_ROOT}/CONF_SYSTEM`
}

export function getLegacyV1SettingsPath() {
  return `${MONOLITO_ROOT}/LEGACY_DISABLED`
}

export function ensureSystemModelEnvMarkers(env: NodeJS.ProcessEnv = process.env) {
  if (env[SYSTEM_AUTH_TOKEN_ENV] === undefined) {
    env[SYSTEM_AUTH_TOKEN_ENV] = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? ""
  }
  if (env[SYSTEM_BASE_URL_ENV] === undefined) {
    env[SYSTEM_BASE_URL_ENV] = env.ANTHROPIC_BASE_URL ?? ""
  }
  if (env[SYSTEM_MODEL_ENV] === undefined) {
    env[SYSTEM_MODEL_ENV] = env.ANTHROPIC_MODEL ?? ""
  }
}

export function createDefaultSettings(options: ReadSettingsOptions = {}): ModelSettings {
  const env = options.env ?? process.env
  ensureSystemModelEnvMarkers(env)
  const defaults = createDefaultSystemConfig()
  return {
    modelConfig: {
      protocol: MODEL_PROTOCOL,
    },
    env: {
      ANTHROPIC_BASE_URL:
        getSystemValue(env, SYSTEM_BASE_URL_ENV, "ANTHROPIC_BASE_URL") ||
        defaults.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN:
        getSystemValue(env, SYSTEM_AUTH_TOKEN_ENV, "ANTHROPIC_AUTH_TOKEN") ||
        getSystemValue(env, SYSTEM_AUTH_TOKEN_ENV, "ANTHROPIC_API_KEY") ||
        defaults.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_MODEL:
        getSystemValue(env, SYSTEM_MODEL_ENV, "ANTHROPIC_MODEL") ||
        defaults.env.ANTHROPIC_MODEL,
      API_TIMEOUT_MS: defaults.env.API_TIMEOUT_MS,
    },
  }
}

export function readModelSettings(options: ReadSettingsOptions = {}): ModelSettings {
  const defaults = createDefaultSettings(options)
  const raw = readConfigWing(process.cwd(), "CONF_SYSTEM") as Partial<ModelSettings>
  return {
    modelConfig: {
      protocol: normalizeString(raw.modelConfig?.protocol) || defaults.modelConfig.protocol,
    },
    env: {
      ANTHROPIC_BASE_URL: normalizeString(raw.env?.ANTHROPIC_BASE_URL) || defaults.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: normalizeString(raw.env?.ANTHROPIC_AUTH_TOKEN) || defaults.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_MODEL: normalizeString(raw.env?.ANTHROPIC_MODEL) || defaults.env.ANTHROPIC_MODEL,
      API_TIMEOUT_MS: normalizeString(raw.env?.API_TIMEOUT_MS) || defaults.env.API_TIMEOUT_MS,
    },
  }
}

export function settingsToDraft(settings: ModelSettings): ModelDraft {
  return {
    protocol: settings.modelConfig.protocol,
    baseUrl: settings.env.ANTHROPIC_BASE_URL,
    apiKey: settings.env.ANTHROPIC_AUTH_TOKEN,
    model: settings.env.ANTHROPIC_MODEL,
  }
}

export function draftToSettings(draft: ModelDraft, options: ReadSettingsOptions = {}): ModelSettings {
  const defaults = createDefaultSettings(options)
  return {
    modelConfig: {
      protocol: MODEL_PROTOCOL,
    },
    env: {
      ANTHROPIC_BASE_URL: draft.baseUrl.trim(),
      ANTHROPIC_AUTH_TOKEN: draft.apiKey.trim(),
      ANTHROPIC_MODEL: draft.model.trim(),
      API_TIMEOUT_MS: defaults.env.API_TIMEOUT_MS,
    },
  }
}

export function validateModelDraft(draft: ModelDraft, env: NodeJS.ProcessEnv = process.env) {
  ensureSystemModelEnvMarkers(env)
  const errors: string[] = []
  if ((draft.protocol || "").trim() !== MODEL_PROTOCOL) {
    errors.push(`Protocol must be ${MODEL_PROTOCOL}`)
  }
  if (!(draft.model || "").trim()) {
    errors.push("Model is required")
  }
  const systemToken =
    getSystemValue(env, SYSTEM_AUTH_TOKEN_ENV, "ANTHROPIC_AUTH_TOKEN") ||
    getSystemValue(env, SYSTEM_AUTH_TOKEN_ENV, "ANTHROPIC_API_KEY")
  if (!(draft.apiKey || "").trim() && !systemToken.trim()) {
    errors.push("API key is required unless it already exists in the system environment")
  }
  return errors
}

export function saveModelSettings(settings: ModelSettings) {
  writeConfigWing(process.cwd(), "CONF_SYSTEM", settings)
  appendActionLog(process.cwd(), "Cambio de configuracion del sistema", {
    wing: "CONF_SYSTEM",
    model: settings.env.ANTHROPIC_MODEL,
    baseUrl: settings.env.ANTHROPIC_BASE_URL,
  })
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
  ensureSystemModelEnvMarkers(env)
  const effectiveToken =
    settings.env.ANTHROPIC_AUTH_TOKEN.trim() ||
    getSystemValue(env, SYSTEM_AUTH_TOKEN_ENV, "ANTHROPIC_AUTH_TOKEN") ||
    getSystemValue(env, SYSTEM_AUTH_TOKEN_ENV, "ANTHROPIC_API_KEY")
  const effectiveBaseUrl =
    settings.env.ANTHROPIC_BASE_URL.trim() ||
    getSystemValue(env, SYSTEM_BASE_URL_ENV, "ANTHROPIC_BASE_URL")
  const effectiveModel =
    settings.env.ANTHROPIC_MODEL.trim() ||
    getSystemValue(env, SYSTEM_MODEL_ENV, "ANTHROPIC_MODEL")

  env.ANTHROPIC_BASE_URL = effectiveBaseUrl
  env.ANTHROPIC_AUTH_TOKEN = effectiveToken
  env.ANTHROPIC_API_KEY = effectiveToken
  env.ANTHROPIC_MODEL = effectiveModel
  env.API_TIMEOUT_MS = settings.env.API_TIMEOUT_MS
  return env
}

export function refreshModelAuth(env: NodeJS.ProcessEnv = process.env) {
  const settings = readModelSettings({ env })
  return applyModelSettingsToEnv(env, settings)
}

/**
 * Apply a ModelProfile directly to env vars (used when switching profiles).
 */
export function applyProfileToEnv(env: NodeJS.ProcessEnv, profile: ModelProfile) {
  ensureSystemModelEnvMarkers(env)
  env.ANTHROPIC_BASE_URL = profile.baseUrl.trim()
  env.ANTHROPIC_AUTH_TOKEN = profile.apiKey.trim()
  env.ANTHROPIC_API_KEY = profile.apiKey.trim()
  env.ANTHROPIC_MODEL = profile.model.trim()
  env.MONOLITO_ACTIVE_PROVIDER = profile.provider
  return env
}

export function loadAndApplyModelSettings(env: NodeJS.ProcessEnv = process.env) {
  // Prefer active profile from registry
  const activeProfile = getActiveProfile()
  if (activeProfile) {
    applyProfileToEnv(env, activeProfile)
    return readModelSettings({ env })
  }
  // Fallback to legacy settings
  const settings = readModelSettings({ env })
  applyModelSettingsToEnv(env, settings)
  return settings
}
