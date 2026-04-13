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
  }
}

export type ModelDraft = {
  protocol: string
  baseUrl: string
  apiKey: string
  model: string
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
    },
  }
}

export function readModelSettings(): ModelSettings {
  const defaults = createDefaultSettings()
  const raw = coerceConfigRecord(readConfigWing(process.cwd(), "CONF_SYSTEM")) as Partial<ModelSettings> | null
  return {
    modelConfig: {
      protocol: normalizeString(raw?.modelConfig?.protocol) || defaults.modelConfig.protocol,
    },
    env: {
      ANTHROPIC_BASE_URL: normalizeString(raw?.env?.ANTHROPIC_BASE_URL) || defaults.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: normalizeString(raw?.env?.ANTHROPIC_AUTH_TOKEN) || defaults.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_MODEL: normalizeString(raw?.env?.ANTHROPIC_MODEL) || defaults.env.ANTHROPIC_MODEL,
      API_TIMEOUT_MS: normalizeString(raw?.env?.API_TIMEOUT_MS) || defaults.env.API_TIMEOUT_MS,
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
  env.ANTHROPIC_BASE_URL = settings.env.ANTHROPIC_BASE_URL.trim()
  env.ANTHROPIC_AUTH_TOKEN = settings.env.ANTHROPIC_AUTH_TOKEN.trim()
  env.ANTHROPIC_API_KEY = settings.env.ANTHROPIC_AUTH_TOKEN.trim()
  env.ANTHROPIC_MODEL = settings.env.ANTHROPIC_MODEL.trim()
  env.API_TIMEOUT_MS = settings.env.API_TIMEOUT_MS
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
