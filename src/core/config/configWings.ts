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
  "CONF_MEMORYAGENT",
] as const

export type ConfigWingName = (typeof CONFIG_WING_ORDER)[number]

export type ConfigWingValueMap = {
  CONF_MODELS: ModelRegistry
  CONF_SYSTEM: ModelSettings
  CONF_CHANNELS: ChannelsConfig
  CONF_WEBSEARCH: WebSearchConfig
  CONF_MCP: Record<string, ResolvedMcpServerConfig>
  CONF_POLICY: PolicyConfig
  CONF_MEMORYAGENT: MemoryAgentConfig
}

export type MemoryAgentConfig = {
  enabled: boolean
  min_idle_minutes: number
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
  /**
   * Hook execution type. Defaults to "command" (run a shell command and parse
   * its stdout as JSON). "prompt" runs an LLM judge inline with the supplied
   * prompt and parses the response as JSON.
   */
  type?: "command" | "prompt"
  commands?: HookCommand[]
  /**
   * For "prompt" hooks: the LLM-judge prompt. The runtime substitutes these
   * placeholders before invoking the model:
   *   $TOOL_NAME, $TOOL_INPUT, $USER_MESSAGE, $SESSION_ID, $PROFILE_ID
   * For "command" hooks, the placeholders are passed as env vars instead.
   */
  prompt?: string
  /**
   * For "prompt" hooks: max tokens for the judge response. Default 120.
   */
  maxTokens?: number
  /**
   * Optional: a short human-readable description of what this hook does.
   * Surfaces in audit logs when the hook fires.
   */
  description?: string
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
      MONOLITO_AUTO_ACK: "true",
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
      // Default PreToolUse hooks: catch intent-mismatch before destructive
      // tools execute. Two hooks cover the two patterns observed in the
      // local Monolito audit:
      //
      // 1) Read-only intent (list/show/see/view) + write action (delete/edit
      //    /write/...) → deny. Catches the "listame las skills, no las borres"
      //    failure mode.
      // 2) Current turn does not mention this action at all (even if a
      //    previous turn did) → deny. Catches the session-memory bleed where
      //    the agent chains a previous implicit task with a new explicit one.
      //
      // Both hooks use the "prompt" type which runs an inline LLM judge
      // with $USER_MESSAGE and $TOOL_NAME placeholders. The judge reasons
      // semantically about the user's intent, so the rules are language-
      // agnostic (work for Spanish, English, etc.).
      PreToolUse: [
        {
          matcher: {
            tool: "DeleteSkill|ArchiveSkill|Write|Edit|MultiEdit|CreateSkill|DeleteSkill|RestoreSkill|TelegramSend|TelegramSendPhoto|TelegramSendAudio|TelegramSendVoice|Bash",
          },
          type: "prompt",
          description: "Intent-mismatch: deny if user asked to read-only but tool mutates state",
          prompt: [
            "You are the runtime's intent-mismatch policy hook. Decide whether the tool call below matches the user's CURRENT message.",
            "",
            "User's current message (verbatim):",
            "\"\"\"$USER_MESSAGE\"\"\"",
            "",
            "Tool being invoked: $TOOL_NAME",
            "Tool input: $TOOL_INPUT",
            "",
            "DECISION CRITERIA:",
            "1. If the user's current message is a READ-ONLY request (asking to list, show, see, view, display, enumerate, count, or describe the current state of something) AND the tool is a STATE-MUTATING action (delete, archive, update, write, edit, send-message, send-photo, send-audio, send-voice, or any Bash that mutates files), respond with DENY. The agent is over-acting on a read-only intent.",
            "2. If the user's current message does NOT mention the action the tool is performing AND the action is destructive or hard-to-reverse (delete, archive, send-message, etc.), respond with DENY. The agent is chaining an action from a previous turn without re-confirmation. A new user message is a new turn with a new boundary; do not act on prior context.",
            "3. Otherwise (the user explicitly asks for the action in their current message, or the action is clearly aligned with the stated intent), respond with ALLOW.",
            "",
            "EXAMPLES:",
            "- User: \"listame las skills\", tool: DeleteSkill → DENY (read-only intent, write action)",
            "- User: \"mostrame los archivos\", tool: Edit → DENY (read-only intent, write action)",
            "- User: \"borrá las skills\", tool: DeleteSkill → ALLOW (user explicitly asks)",
            "- User: \"listame las skills\", tool: ListSkills → ALLOW (read-only + read-only)",
            "- User: \"que paso con X?\", tool: Bash with `ls` → ALLOW (read-only intent + read-only action)",
            "- User: \"como estas?\", tool: DeleteSkill (from prior turn's pending delete) → DENY (current turn doesn't mention delete)",
            "",
            "When in doubt, ALLOW — continuity beats strictness. Only deny when the mismatch is unambiguous.",
            "",
            "Respond with a single JSON object on one line. Schema: {\"decision\": \"allow\" | \"deny\", \"reason\": \"short explanation in English\"}",
          ].join("\n"),
          maxTokens: 150,
        },
      ],
      PostToolUse: [],
      SessionStart: [],
      SessionEnd: [],
    },
  },
  CONF_MEMORYAGENT: {
    enabled: true,
    min_idle_minutes: 3,
  },
}
