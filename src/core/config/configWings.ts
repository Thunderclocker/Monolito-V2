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
  "CONF_POLICY",
  "CONF_HEARTBEAT",
  "CONF_SKILLS",
] as const

export type ConfigWingName = (typeof CONFIG_WING_ORDER)[number]

export type ConfigWingValueMap = {
  CONF_MODELS: ModelRegistry
  CONF_SYSTEM: ModelSettings
  CONF_CHANNELS: ChannelsConfig
  CONF_WEBSEARCH: WebSearchConfig
  CONF_MCP: Record<string, ResolvedMcpServerConfig>
  CONF_POLICY: PolicyConfig
  CONF_HEARTBEAT: HeartbeatConfig
  CONF_SKILLS: SkillsConfig
}

export type HeartbeatConfig = {
  enabled: boolean
  interval_minutes: number
  min_idle_minutes: number
}

export type SkillsConfig = {
  // Number of tool iterations in a user turn before triggering skill creation.
  // Mirrors Hermes's `skills.creation_nudge_interval`.
  creation_nudge_interval: number
  // Number of user-turns between curator passes. Curator only acts on
  // agent-created skills (provenance === "agent").
  curation_session_interval: number
  // Optional defensive scan of agent-created skill guides for threat patterns.
  guard_agent_created: boolean
  // Don't archive agent-created skills younger than this many sessions. Avoids
  // curator killing fresh useful skills before they get a chance to be used.
  min_age_sessions_before_curate: number
}

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions"

export type PermissionRule = {
  tool?: string
  action: "allow" | "deny" | "ask"
  input?: string
}

export type HookMatcher = {
  tool?: string
  input?: string
  session?: string
  profile?: string
}

export type HookCommand = {
  cmd: string
}

export type HookDefinition = {
  matcher?: HookMatcher
  commands: HookCommand[]
}

export type PolicyConfig = {
  permissions: {
    mode: PermissionMode
    rules: PermissionRule[]
  }
  hooks: {
    PreToolUse: HookDefinition[]
    PostToolUse: HookDefinition[]
    SessionStart: HookDefinition[]
    SessionEnd: HookDefinition[]
  }
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
      MAX_BUDGET_USD: "0",
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
  CONF_POLICY: {
    permissions: {
      mode: "acceptEdits",
      rules: [
        { tool: "Bash", action: "allow", input: "git status*" },
        { tool: "Bash", action: "allow", input: "npm test*" },
      ],
    },
    hooks: {
      PreToolUse: [],
      PostToolUse: [],
      SessionStart: [],
      SessionEnd: [],
    },
  },
  CONF_HEARTBEAT: {
    enabled: true,
    interval_minutes: 30,
    min_idle_minutes: 12,
  },
  CONF_SKILLS: {
    creation_nudge_interval: 10,
    curation_session_interval: 20,
    guard_agent_created: false,
    min_age_sessions_before_curate: 5,
  },
}
