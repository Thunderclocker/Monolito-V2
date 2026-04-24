import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { MONOLITO_ROOT } from "../system/root.ts"
import { runBackgroundTextTask } from "./modelAdapterLite.ts"
import { getTool } from "../tools/registry.ts"

const execFileAsync = promisify(execFile)

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions"

type HookDecision = "approve" | "allow" | "block" | "deny" | "continue"

type PermissionRule = {
  tool?: string
  action: "allow" | "deny" | "ask"
  input?: string
}

type HookMatcher = {
  tool?: string
  input?: string
  session?: string
  profile?: string
}

type HookCommand = {
  cmd: string
}

type HookDefinition = {
  matcher?: HookMatcher
  commands: HookCommand[]
}

type PermissionsFile = {
  mode?: PermissionMode
  rules?: PermissionRule[]
}

type HooksFile = {
  PreToolUse?: HookDefinition[]
  PostToolUse?: HookDefinition[]
  SessionStart?: HookDefinition[]
  SessionEnd?: HookDefinition[]
}

export type PermissionContext = {
  rootDir: string
  sessionId: string
  profileId?: string
}

export type PermissionCheckResult = {
  behavior: "allow" | "deny" | "ask"
  source: "mode" | "rule" | "hook"
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

function getPermissionsPath(rootDir?: string) {
  void rootDir
  return join(MONOLITO_ROOT, "permissions.json")
}

function getHooksPath(rootDir?: string) {
  void rootDir
  return join(MONOLITO_ROOT, "hooks.json")
}

export function ensurePermissionFiles(rootDir?: string) {
  for (const path of [getPermissionsPath(rootDir), getHooksPath(rootDir)]) {
    mkdirSync(dirname(path), { recursive: true })
  }
}

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return fallback
  }
}

function readPermissionsConfig(rootDir?: string): Required<PermissionsFile> {
  ensurePermissionFiles(rootDir)
  const raw = readJsonFile<PermissionsFile>(getPermissionsPath(rootDir), {})
  const mode: PermissionMode = raw.mode === "default" || raw.mode === "acceptEdits" || raw.mode === "bypassPermissions"
    ? raw.mode
    : "acceptEdits"
  return {
    mode,
    rules: Array.isArray(raw.rules) ? raw.rules.filter(rule => rule && typeof rule.action === "string") : [],
  }
}

function readHooksConfig(rootDir?: string): HooksFile {
  ensurePermissionFiles(rootDir)
  return readJsonFile<HooksFile>(getHooksPath(rootDir), {})
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

function isDangerousBash(command: string) {
  return /\b(rm|dd|mkfs|fdisk|parted|shutdown|reboot|poweroff|halt|kill|pkill|killall)\b/i.test(command) ||
    /\bsystemctl\s+(stop|restart|disable)\b/i.test(command)
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

function isSafeReadOnlyBash(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim()
  if (!normalized) return false
  if (isDangerousBash(normalized)) return false
  if (isAdHocSpeechProcessingBash(normalized)) return false
  return DEFAULT_SAFE_BASH_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix} `))
}

function evaluateMode(mode: PermissionMode, toolName: string, input: Record<string, unknown>): PermissionCheckResult {
  if (mode === "bypassPermissions") {
    return { behavior: "allow", source: "mode" }
  }
  if (toolName === "Bash") {
    const command = getBashCommand(input)
    if (isAdHocSpeechProcessingBash(command)) {
      return {
        behavior: "deny",
        source: "mode",
        message: "Ad-hoc Bash speech processing is denied. Use GenerateSpeech, TranscribeAudio, TtsService*, or SttService* instead.",
      }
    }
    if (mode === "default") {
      return isSafeReadOnlyBash(command)
        ? { behavior: "allow", source: "mode" }
        : { behavior: "deny", source: "mode", message: "Bash command requires an allow rule or a less restrictive permission mode." }
    }
    if (isDangerousBash(command)) {
      return { behavior: "deny", source: "mode", message: "Dangerous Bash command denied by permission mode." }
    }
    return { behavior: "allow", source: "mode" }
  }
  const tool = getTool(toolName)
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

export async function checkToolPermission(toolName: string, input: Record<string, unknown>, context: PermissionContext): Promise<PermissionCheckResult> {
  const permissions = readPermissionsConfig(context.rootDir)
  const hooks = readHooksConfig(context.rootDir)
  const hookDecision = await runHookCommands("PreToolUse", hooks.PreToolUse, toolName, input, context)
  if (hookDecision) return hookDecision

  const ruleDecision = evaluateRules(toolName, input, permissions.rules)
  if (ruleDecision?.behavior === "ask") {
    return await evaluateSemanticPermission(toolName, input, context)
  }
  if (ruleDecision) return ruleDecision

  return evaluateMode(permissions.mode, toolName, input)
}

export async function runPostToolHooks(toolName: string, input: Record<string, unknown>, context: PermissionContext, output: unknown) {
  const hooks = readHooksConfig(context.rootDir)
  await runHookCommands("PostToolUse", hooks.PostToolUse, toolName, input, context, output)
}

export async function runLifecycleHooks(event: "SessionStart" | "SessionEnd", context: PermissionContext) {
  const hooks = readHooksConfig(context.rootDir)
  const targetHooks = hooks[event]
  if (!targetHooks || targetHooks.length === 0) return
  await runHookCommands(event, targetHooks, "System", {}, context)
}
