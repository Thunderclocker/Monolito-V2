import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import { runBackgroundTextTask } from "./modelAdapter.ts"
import { getTool } from "../tools/registry.ts"
import { DEFAULT_CONFIG_WING_VALUES, type HookDefinition, type PermissionMode, type PermissionRule, type PolicyConfig } from "../config/configWings.ts"
import { readConfigWing } from "../session/store.ts"

const execFileAsync = promisify(execFile)

type HookDecision = "approve" | "allow" | "block" | "deny" | "continue"

export type PermissionContext = {
  rootDir: string
  sessionId: string
  profileId?: string
  /**
   * The user's most recent user-role message text in this session. Used by
   * PreToolUse prompt hooks to detect intent-mismatch (e.g. user asked to
   * "list" but the agent is calling a destructive tool). Optional for
   * backward compatibility — hooks that need it will receive an empty
   * string when the caller does not supply it.
   */
  lastUserText?: string
}

export type PermissionCheckResult = {
  behavior: "allow" | "deny" | "ask"
  source: "mode" | "rule" | "hook" | "destructive_guard" | "sudo_guard"
  message?: string
}

const DEFAULT_SAFE_BASH_PREFIXES = [
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "find",
  "grep",
  "rg",
  "sed -n",
  "awk",
  "cut",
  "sort",
  "uniq",
  "wc",
  "stat",
  "file",
  "du",
  "df",
  "ps",
  "pgrep",
  "ss",
  "netstat",
  "lsof",
  "env",
  "printenv",
  "which",
  "whereis",
  "id",
  "whoami",
  "date",
  "uname",
  "uptime",
  "docker ps",
  "systemctl status",
  "journalctl -n",
]

export function ensurePermissionFiles(rootDir?: string) {
  void rootDir
}

function normalizePolicyConfig(raw: unknown): PolicyConfig {
  const defaults = DEFAULT_CONFIG_WING_VALUES.CONF_POLICY
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults
  const record = raw as Partial<PolicyConfig>
  const permissions = record.permissions && typeof record.permissions === "object" && !Array.isArray(record.permissions)
    ? record.permissions
    : defaults.permissions
  const hooks = record.hooks && typeof record.hooks === "object" && !Array.isArray(record.hooks)
    ? record.hooks
    : defaults.hooks
  const mode: PermissionMode = permissions.mode === "default" || permissions.mode === "acceptEdits" || permissions.mode === "bypassPermissions"
    ? permissions.mode
    : defaults.permissions.mode
  return {
    permissions: {
      mode,
      rules: Array.isArray(permissions.rules)
        ? permissions.rules.filter(rule => rule && typeof rule.action === "string")
        : defaults.permissions.rules,
    },
    hooks: {
      PreToolUse: Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [],
      PostToolUse: Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [],
      SessionStart: Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [],
      SessionEnd: Array.isArray(hooks.SessionEnd) ? hooks.SessionEnd : [],
    },
  }
}

function readPolicyConfig(rootDir: string): PolicyConfig {
  ensurePermissionFiles(rootDir)
  return normalizePolicyConfig(readConfigWing(rootDir, "CONF_POLICY"))
}

function globToRegExp(glob: string) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "i")
}

function matchesGlob(value: string, pattern?: string) {
  if (!pattern || pattern.trim().length === 0) return true
  return globToRegExp(pattern.trim()).test(value)
}

function summarizeInput(input: Record<string, unknown>) {
  try {
    return JSON.stringify(input)
  } catch {
    return ""
  }
}

function getBashCommand(input: Record<string, unknown>) {
  return typeof input.command === "string" ? input.command.trim() : ""
}

// Destructive command tokens that we want to flag at the start of a pipeline
// segment. Matched case-insensitively. Order matters: longer tokens first so
// "systemctl" is not preempted by "systemctl-reboot-subcommand" weirdness.
const DESTRUCTIVE_TOKENS = new Set([
  // Filesystem destruction
  "rm", "rmdir", "unlink", "shred", "wipe", "srm",
  // Disk / partition tools
  "dd", "mkfs", "mkfs.ext4", "mkfs.xfs", "mkfs.btrfs", "fdisk", "parted", "sfdisk",
  // Process / system control
  "shutdown", "reboot", "poweroff", "halt", "init", "telinit",
  "kill", "killall", "pkill", "pkillall",
  // Privilege escalation often used in destructive flows
  // (sudo is matched separately below)
])

const DESTRUCTIVE_SUBCOMMANDS: Array<{ cmd: RegExp; verbs: string[] }> = [
  { cmd: /^systemctl$/i, verbs: ["stop", "restart", "disable", "mask", "kill", "isolate"] },
  { cmd: /^service$/i,    verbs: ["stop", "restart", "disable"] },
  { cmd: /^rc-service$/i,  verbs: ["stop", "restart"] },
  { cmd: /^docker$/i,      verbs: ["rm", "rmi", "system", "prune", "kill", "stop"] },
  { cmd: /^podman$/i,      verbs: ["rm", "rmi", "system", "prune", "kill", "stop"] },
  { cmd: /^kubectl$/i,     verbs: ["delete", "drain", "cordon", "taint"] },
  { cmd: /^firewall-cmd$/i, verbs: ["--reload", "panic-on", "panic-off"] },
]

/**
 * Tokenize a shell command into pipeline segments and yield the first
 * "real" command token of each segment, after stripping:
 *   - leading `VAR=value` env-var assignments
 *   - leading `sudo` / `doas` / `su -c`
 *   - leading `command` builtin
 *   - leading `nohup` / `time`
 * Returns lowercase tokens. Stops at `--`.
 */
function* iterateHeadTokens(command: string): Generator<string> {
  const segments = command.split(/[|&;]\|?|\$\(|\)/)
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const tokens = trimmed.split(/\s+/)
    let i = 0
    // Strip env-var assignments: NAME=VALUE
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
    // Strip leading wrappers
    const wrappers = new Set(["sudo", "doas", "command", "nohup", "time", "nice", "stdbuf", "env"])
    while (i < tokens.length && wrappers.has(tokens[i]!.toLowerCase())) {
      i++
      // After sudo, there may be options like `-u root` or `-E` — skip flags.
      while (i < tokens.length && tokens[i]!.startsWith("-")) i++
    }
    if (i < tokens.length) {
      const head = tokens[i]!.toLowerCase()
      // Strip a leading path (e.g. /bin/rm, /usr/bin/systemctl)
      const base = head.split("/").pop() ?? head
      yield base
    }
  }
}

function isDangerousBash(command: string) {
  const segments: string[] = []
  for (const head of iterateHeadTokens(command)) {
    if (DESTRUCTIVE_TOKENS.has(head)) return true
    for (const { cmd, verbs } of DESTRUCTIVE_SUBCOMMANDS) {
      if (cmd.test(head)) {
        // Find the verb in the original segment (case-insensitive).
        const segmentText = command.toLowerCase()
        // Look for the head token followed by whitespace and a verb
        const escapedHead = head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const verbMatch = new RegExp(`\\b${escapedHead}\\s+(\\S+)`, "i").exec(segmentText)
        if (verbMatch && verbs.includes(verbMatch[1]!.toLowerCase())) return true
      }
    }
  }
  // Also catch obvious systemctl/service state-mutating verbs at the head.
  // We intentionally do NOT include poweroff/reboot/halt here because those
  // are legitimate user-initiated operations that the original code wrongly
  // flagged as destructive (false positive). The standalone commands
  // (reboot, poweroff, halt) are still caught via DESTRUCTIVE_TOKENS.
  if (/^\s*(sudo\s+)?(systemctl|service)\s+(stop|restart|disable|mask|kill|isolate|panic-on|panic-off)\b/i.test(command)) {
    return true
  }
  // Classic fork bomb pattern
  if (/:\(\)\s*\{.*:\|:.*\};:/m.test(command)) return true
  // Truncate / wipe a whole device (catches cases not in head tokens)
  if (/\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|hd|xvd|vd|mmcblk|loop|disk|dasd)/i.test(command)) return true
  return false
}

export function isDestructiveAction(toolName: string, input: Record<string, unknown>): {
  destructive: boolean
  reason?: string
} {
  if (toolName === "Bash") {
    const command = getBashCommand(input)
    if (isDangerousBash(command)) {
      return { destructive: true, reason: `Bash: "${command}" contains destructive commands.` }
    }
  }
  return { destructive: false }
}

function isAdHocSpeechProcessingBash(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase()
  if (!normalized) return false
  return (
    /faster[_-]?whisper/.test(normalized) ||
    /\bwhispermodel\b/.test(normalized) ||
    /\bimport +whisper\b/.test(normalized) ||
    /\bimport +faster_whisper\b/.test(normalized) ||
    /openai-whisper-asr-webservice/.test(normalized) ||
    /\bedge-tts\b/.test(normalized) ||
    /\/v1\/audio\/speech/.test(normalized) ||
    /\/asr(\?|["'\s]|$)/.test(normalized)
  )
}

function isAdHocVisionOrLlmBash(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase()
  if (!normalized) return false
  return (
    /client\.beta\.vision/.test(normalized) ||
    /\bopenai\.vision\b/.test(normalized) ||
    /\banthropic\.messages\b/.test(normalized) ||
    /\/v1\/(?:chat\/completions|responses)\b/.test(normalized) ||
    /\/api\/generate\b/.test(normalized) ||
    /\/api\/chat\b/.test(normalized) ||
    /\b(import|from) +openai\b/.test(normalized) ||
    /\b(import|from) +anthropic\b/.test(normalized)
  )
}

function isSafeReadOnlyBash(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim()
  if (!normalized) return false
  if (isDangerousBash(normalized)) return false
  if (isAdHocSpeechProcessingBash(normalized)) return false
  if (isAdHocVisionOrLlmBash(normalized)) return false
  return DEFAULT_SAFE_BASH_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix} `))
}

function evaluateMode(mode: PermissionMode, toolName: string, input: Record<string, unknown>, rootDir?: string): PermissionCheckResult {
  if (mode === "bypassPermissions") {
    return { behavior: "allow", source: "mode" }
  }
  if (toolName === "Bash") {
    const command = getBashCommand(input)
    if (isAdHocSpeechProcessingBash(command)) {
      return {
        behavior: "deny",
        source: "mode",
        message: "Ad-hoc Bash speech processing is denied. Use GenerateSpeech, TranscribeAudio, or SttService* instead.",
      }
    }
    if (isAdHocVisionOrLlmBash(command)) {
      return {
        behavior: "deny",
        source: "mode",
        message: "Ad-hoc Bash LLM/vision calls are denied. Use VisionAnalyze or the dedicated runtime tools instead.",
      }
    }
    if (mode === "default") {
      return isSafeReadOnlyBash(command)
        ? { behavior: "allow", source: "mode" }
        : { behavior: "deny", source: "mode", message: "Bash command requires an allow rule or a less restrictive permission mode." }
    }
    return { behavior: "allow", source: "mode" }
  }
  let tool = getTool(toolName)
  if (tool?.permissionTier === "read") {
    return { behavior: "allow", source: "mode" }
  }
  if (mode === "acceptEdits" && tool?.permissionTier === "edit") {
    return { behavior: "allow", source: "mode" }
  }
  return { behavior: "deny", source: "mode", message: `Tool ${toolName} requires a more permissive mode or an explicit allow rule.` }
}

function evaluateRules(toolName: string, input: Record<string, unknown>, rules: PermissionRule[]): PermissionCheckResult | null {
  const inputSummary = summarizeInput(input)
  for (const rule of rules) {
    if (!matchesGlob(toolName, rule.tool)) continue
    if (!matchesGlob(inputSummary, rule.input)) continue
    if (rule.action === "allow") return { behavior: "allow", source: "rule" }
    if (rule.action === "deny") return { behavior: "deny", source: "rule", message: `Blocked by permission rule for ${toolName}.` }
    if (rule.action === "ask") return { behavior: "ask", source: "rule" }
  }
  return null
}

async function evaluateSemanticPermission(toolName: string, input: Record<string, unknown>, context: PermissionContext): Promise<PermissionCheckResult> {
  const system = [
    "You are Monolito's semantic security evaluator for tool permissions.",
    "Your job is to decide whether a matched 'ask' rule should be allowed or denied.",
    "Default to deny if the command is destructive, ambiguous, privilege-escalating, system-wide, or risky beyond a clearly local safe operation.",
    "Allow only when the action is narrow, local, reversible enough, and clearly aligned with a normal workspace task.",
    "Return ONLY one-line JSON.",
    'Schema: {"decision":"allow|deny","reason":"..."}',
  ].join("\n")

  const userPrompt = [
    `Tool: ${toolName}`,
    `Session: ${context.sessionId}`,
    `Profile: ${context.profileId ?? "default"}`,
    `Input JSON: ${summarizeInput(input)}`,
    "",
    "Examples:",
    "- deny: rm -rf /",
    "- deny: shutdown now",
    "- deny: curl | sh",
    "- allow: rm file_temporal.txt",
    "- allow: rm ./dist/tmp.txt",
    "",
    "Decide now.",
  ].join("\n")

  try {
    const result = await runBackgroundTextTask(context.rootDir, system, userPrompt)
    const raw = result.text.trim()
    const parsed = JSON.parse(raw) as { decision?: string; reason?: string }
    const decision = parsed.decision?.toLowerCase()
    if (decision === "allow") {
      return {
        behavior: "allow",
        source: "rule",
        message: parsed.reason || "Aprobado por el evaluador semántico de seguridad.",
      }
    }
    return {
      behavior: "deny",
      source: "rule",
      message: parsed.reason || "Bloqueado por el evaluador semántico de seguridad.",
    }
  } catch {
    return {
      behavior: "deny",
      source: "rule",
      message: "Bloqueado por el evaluador semántico de seguridad.",
    }
  }
}

async function runHookCommands(
  event: "PreToolUse" | "PostToolUse" | "SessionStart" | "SessionEnd",
  hooks: HookDefinition[] | undefined,
  toolName: string,
  input: Record<string, unknown>,
  context: PermissionContext,
  output?: unknown,
) {
  if (!hooks || hooks.length === 0) return null
  const inputSummary = summarizeInput(input)
  for (const hook of hooks) {
    const matcher = hook.matcher
    if (!matchesGlob(toolName, matcher?.tool)) continue
    if (!matchesGlob(inputSummary, matcher?.input)) continue
    if (!matchesGlob(context.sessionId, matcher?.session)) continue
    if (!matchesGlob(context.profileId ?? "default", matcher?.profile)) continue

    const hookType = hook.type ?? "command"
    if (hookType === "prompt") {
      const result = await runPromptHook(event, hook, toolName, inputSummary, context)
      if (result) return result
      continue
    }

    for (const command of hook.commands ?? []) {
      const shell = process.env.SHELL || "/bin/zsh"
      const result = await execFileAsync(shell, ["-lc", command.cmd], {
        env: {
          ...process.env,
          MONOLITO_HOOK_EVENT: event,
          MONOLITO_TOOL_NAME: toolName,
          MONOLITO_TOOL_INPUT: inputSummary,
          MONOLITO_SESSION_ID: context.sessionId,
          MONOLITO_PROFILE_ID: context.profileId ?? "default",
          MONOLITO_USER_MESSAGE: context.lastUserText ?? "",
          MONOLITO_TOOL_OUTPUT: output === undefined ? "" : summarizeInput({ output }),
        },
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      }).catch(error => {
        const typed = error as Error & { stdout?: string; stderr?: string }
        return {
          stdout: typed.stdout ?? "",
          stderr: typed.stderr ?? typed.message,
        }
      })

      const text = (result.stdout || result.stderr || "").trim()
      if (!text) continue
      try {
        const parsed = JSON.parse(text) as { decision?: HookDecision; message?: string }
        const decision = parsed.decision?.toLowerCase()
        if (decision === "approve" || decision === "allow") {
          return { behavior: "allow" as const, source: "hook" as const, message: parsed.message }
        }
        if (decision === "block" || decision === "deny") {
          return { behavior: "deny" as const, source: "hook" as const, message: parsed.message || `${event} hook blocked ${toolName}.` }
        }
      } catch {
        // Hook output is advisory unless it returns JSON.
      }
    }
  }
  return null
}

/**
 * Run an LLM-judge "prompt" hook. The hook's `prompt` template is rendered
 * by substituting the standard placeholders, then sent to the model via
 * runBackgroundTextTask. The response is parsed as JSON; the first
 * decision-shaped line wins.
 */
async function runPromptHook(
  event: string,
  hook: HookDefinition,
  toolName: string,
  inputSummary: string,
  context: PermissionContext,
): Promise<PermissionCheckResult | null> {
  const template = hook.prompt?.trim()
  if (!template) {
    // Misconfigured prompt hook: log and skip.
    return null
  }
  const rendered = template
    .replace(/\$TOOL_NAME/g, toolName)
    .replace(/\$TOOL_INPUT/g, inputSummary)
    .replace(/\$USER_MESSAGE/g, context.lastUserText ?? "(not available)")
    .replace(/\$SESSION_ID/g, context.sessionId)
    .replace(/\$PROFILE_ID/g, context.profileId ?? "default")
    .replace(/\$EVENT/g, event)

  try {
    const result = await runBackgroundTextTask(
      context.rootDir,
      "You are a strict runtime policy hook. Respond ONLY with a single JSON object on one line. Schema: {\"decision\": \"allow\" | \"deny\", \"reason\": \"short explanation in English\"}.",
      rendered,
      { maxTokens: hook.maxTokens ?? 120 },
    )
    const text = (result.text || "").trim()
    if (!text) return null
    const parsed = JSON.parse(text) as { decision?: string; reason?: string }
    const decision = parsed.decision?.toLowerCase()
    if (decision === "allow" || decision === "approve") {
      return { behavior: "allow" as const, source: "hook" as const, message: parsed.reason }
    }
    if (decision === "deny" || decision === "block") {
      const prefix = hook.description ? `[${hook.description}] ` : ""
      return { behavior: "deny" as const, source: "hook" as const, message: `${prefix}${parsed.reason || "Prompt hook denied " + toolName + "."}` }
    }
  } catch (err) {
    // Fail-open: if the judge errors, do not block the user. Surface to
    // the worklog so we can debug, but do not break the runtime.
    return null
  }
  return null
}

export function requiresSudoPrivilege(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== "Bash") return false
  const command = getBashCommand(input)
  if (!command) return false

  // 1. Explicitly starts with or contains sudo, doas, or su
  if (/\b(sudo|doas|su)\b/i.test(command)) {
    return true
  }

  // 2. Known administrative commands that require root privileges
  const rootCommands = new Set([
    "apt", "apt-get", "dpkg", "snap", "flatpak", "dnf", "yum", "pacman",
    "systemctl", "service", "ufw", "iptables", "visudo", "chown", "chmod"
  ])

  for (const head of iterateHeadTokens(command)) {
    if (rootCommands.has(head)) {
      if (head === "systemctl" || head === "service") {
        const lower = command.toLowerCase()
        if (/\b(status|is-active|is-enabled|list-units|show)\b/.test(lower)) {
          continue
        }
      }
      if (head === "pacman") {
        const lower = command.toLowerCase()
        if (/\b-q\b/.test(lower) || /\b-s[a-z]*i\b/.test(lower)) {
          continue
        }
      }
      if (head === "flatpak") {
        const lower = command.toLowerCase()
        if (/\b(run|search|list|info)\b/.test(lower)) {
          continue
        }
      }
      return true
    }
  }

  return false
}

export async function checkToolPermission(toolName: string, input: Record<string, unknown>, context: PermissionContext): Promise<PermissionCheckResult> {
  const policy = readPolicyConfig(context.rootDir)
  const hookDecision = await runHookCommands("PreToolUse", policy.hooks.PreToolUse, toolName, input, context)
  if (hookDecision) return hookDecision

  const ruleDecision = evaluateRules(toolName, input, policy.permissions.rules)
  let decision: PermissionCheckResult
  if (ruleDecision?.behavior === "ask") {
    decision = await evaluateSemanticPermission(toolName, input, context)
  } else if (ruleDecision) {
    decision = ruleDecision
  } else {
    decision = evaluateMode(policy.permissions.mode, toolName, input, context.rootDir)
  }

  if (decision.behavior === "allow" && policy.permissions.mode !== "bypassPermissions") {
    const isSudoMode = _testExistsSync("/etc/sudoers.d/monolito-temp")
    if (!isSudoMode) {
      if (requiresSudoPrivilege(toolName, input)) {
        return {
          behavior: "ask",
          source: "sudo_guard",
          message: "Este comando requiere privilegios de superusuario (sudo). ¿Deseas activar el modo sudo temporal?",
        }
      }
      const dest = isDestructiveAction(toolName, input)
      if (dest.destructive) {
        return {
          behavior: "ask",
          source: "destructive_guard",
          message: dest.reason,
        }
      }
    }
  }

  return decision
}

export async function runPostToolHooks(toolName: string, input: Record<string, unknown>, context: PermissionContext, output: unknown) {
  const policy = readPolicyConfig(context.rootDir)
  await runHookCommands("PostToolUse", policy.hooks.PostToolUse, toolName, input, context, output)
}

export async function runLifecycleHooks(event: "SessionStart" | "SessionEnd", context: PermissionContext) {
  const policy = readPolicyConfig(context.rootDir)
  const targetHooks = policy.hooks[event]
  if (!targetHooks || targetHooks.length === 0) return
  await runHookCommands(event, targetHooks, "System", {}, context)
}

let _testExistsSync = existsSync
export function _setTestExistsSync(fn: any) {
  _testExistsSync = fn
}
export { _testExistsSync }
