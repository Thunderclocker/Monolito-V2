import type { ChannelsConfig } from "../channels/config.ts"
import type { ModelSettings } from "../runtime/modelConfig.ts"
import type { ModelRegistry } from "../runtime/modelRegistry.ts"
import type { WebSearchConfig } from "../websearch/config.ts"
import { MODEL_PROTOCOL } from "../runtime/modelConstants.ts"
import type { ResolvedMcpServerConfig } from "../mcp/client.ts"

export const CONFIG_WING_ORDER = [
  "CONF_MODELS",
  "CONF_SYSTEM",
  "CONF_CHANNELS",
  "CONF_WEBSEARCH",
  "CONF_MCP",
] as const

export type ConfigWingName = (typeof CONFIG_WING_ORDER)[number]

export type ConfigWingValueMap = {
  CONF_MODELS: ModelRegistry
  CONF_SYSTEM: ModelSettings
  CONF_CHANNELS: ChannelsConfig
  CONF_WEBSEARCH: WebSearchConfig
  CONF_MCP: Record<string, ResolvedMcpServerConfig>
}

export function createDefaultSystemConfig(): ModelSettings {
  return {
    modelConfig: {
      protocol: MODEL_PROTOCOL,
    },
    env: {
      ANTHROPIC_BASE_URL: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "",
      API_TIMEOUT_MS: "3000000",
    },
  }
}

export const DEFAULT_CONFIG_WING_VALUES: ConfigWingValueMap = {
  CONF_MODELS: {
    version: 1,
    profiles: [],
  },
  CONF_SYSTEM: createDefaultSystemConfig(),
  CONF_CHANNELS: {},
  CONF_WEBSEARCH: {
    provider: "default",
  },
  CONF_MCP: {},
}
