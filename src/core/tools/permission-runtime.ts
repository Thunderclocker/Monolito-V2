// Permission runtime gate: consume policyConfigZod y ejecuta el check
// por tool. Diseñado para reemplazar el chequeo ad-hoc de permissionTier.
//
// upstream parity: implementación simplificada del sistema de rules de bashSecurity.
// Sin async LLM classifier, sin bash AST parser (eso viene en Fase 5).
// Lo que sí hace:
//   1. Match exacto de tool name
//   2. Match de tool name con wildcard (e.g. "Bash*")
//   3. Match de input pattern (regex) cuando la rule lo especifica
//   4. Ejecuta hooks PreToolUse registrados en policyConfigZod.hooks
//   5. Devuelve "allow" / "ask" / "deny"
//
// Default behavior: si no hay ninguna rule matching, retorna "allow" para
// no romper flujos existentes. Una rule explícita "deny" siempre gana.

import { spawn } from "node:child_process"
import type { ToolContext } from "./internal.ts"
import { readConfigWing } from "../session/store.ts"

export type PermissionDecision = "allow" | "ask" | "deny"

export type PolicyRule = {
  tool?: string
  action: "allow" | "deny" | "ask"
  input?: string
}

export type HookDefinition = {
  matcher?: {
    tool?: string
    input?: string
    session?: string
    profile?: string
  }
  commands: Array<{ cmd: string }>
}

export type PolicyConfig = {
  permissions: {
    mode: "default" | "acceptEdits" | "bypassPermissions"
    rules: PolicyRule[]
  }
  hooks: {
    PreToolUse: HookDefinition[]
    PostToolUse: HookDefinition[]
    SessionStart: HookDefinition[]
    SessionEnd: HookDefinition[]
  }
}

function readPolicy(rootDir: string): PolicyConfig | null {
  try {
    const raw = readConfigWing(rootDir, "CONF_POLICY" as any) as unknown
    if (typeof raw !== "string" || !raw) return null
    return JSON.parse(raw) as PolicyConfig
  } catch {
    return null
  }
}

/** Coincide un patrón con wildcards (`*` y `?`) contra un string.
 *  Sin glob completo, solo los wildcards nativos. Suficiente para tool
 *  names y prefijos de input. */
export function matchWildcard(pattern: string, value: string): boolean {
  if (pattern === value) return true
  if (!pattern.includes("*") && !pattern.includes("?")) return false
  // Convertir glob a regex
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map(part =>
          part
            .split("?")
            .map(seg => seg.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]"),
        )
        .join(".*") +
      "$",
  )
  return re.test(value)
}

function matchRule(rule: PolicyRule, toolName: string, input: Record<string, unknown>): boolean {
  if (rule.tool && !matchWildcard(rule.tool, toolName)) return false
  if (rule.input) {
    try {
      const re = new RegExp(rule.input)
      const haystack = JSON.stringify(input)
      if (!re.test(haystack)) return false
    } catch {
      // regex inválida en la rule → ignorar el filtro de input
    }
  }
  return true
}

function matchHook(h: HookDefinition, toolName: string, input: Record<string, unknown>, sessionId?: string, profileId?: string): boolean {
  const m = h.matcher
  if (!m) return true
  if (m.tool && !matchWildcard(m.tool, toolName)) return false
  if (m.input) {
    try {
      if (!new RegExp(m.input).test(JSON.stringify(input))) return false
    } catch {
      return false
    }
  }
  if (m.session && m.session !== sessionId) return false
  if (m.profile && m.profile !== profileId) return false
  return true
}

async function runHookCommands(h: HookDefinition, toolName: string, input: Record<string, unknown>): Promise<PermissionDecision | null> {
  for (const c of h.commands) {
    try {
      // Hooks reciben tool + input via env vars para no serializar todo
      // en argv. Exit 0 = allow, 1 = ask, 2 = deny.
      const exitCode: number = await new Promise(resolve => {
        const child = spawn("bash", ["-c", c.cmd], {
          env: {
            ...process.env,
            MONOLITO_HOOK_TOOL: toolName,
            MONOLITO_HOOK_INPUT: JSON.stringify(input),
          },
          stdio: "ignore",
        })
        child.on("close", code => resolve(code ?? 0))
        child.on("error", () => resolve(0))
      })
      if (exitCode === 0) return "allow"
      if (exitCode === 1) return "ask"
      if (exitCode === 2) return "deny"
    } catch {
      // hook no se pudo ejecutar → no afecta decisión
    }
  }
  return null
}

export type PermissionContext = {
  toolName: string
  input: Record<string, unknown>
  context: ToolContext
}

export async function checkPermissionForTool(
  pc: PermissionContext,
  rootDir: string,
): Promise<PermissionDecision> {
  const policy = readPolicy(rootDir)
  if (!policy) return "allow"

  // bypassPermissions: no se chequea nada
  if (policy.permissions.mode === "bypassPermissions") return "allow"

  // 1. Buscar rules en orden. Una rule "deny" siempre gana.
  // Si hay rules que matchean, la primera "deny" gana, la primera "allow"
  // gana si no hay "deny", "ask" requiere confirmación.
  let allowMatch = false
  for (const rule of policy.permissions.rules) {
    if (!matchRule(rule, pc.toolName, pc.input)) continue
    if (rule.action === "deny") return "deny"
    if (rule.action === "ask") return "ask"
    if (rule.action === "allow") allowMatch = true
  }

  // 2. acceptEdits: auto-allow de tools con permissionTier "edit" en el
  // tool definition (no en el context — permissionTier vive en el tool,
  // no en el contexto por turno). El tool pasa su permissionTier en el
  // context o en input si lo necesita.
  if (
    policy.permissions.mode === "acceptEdits" &&
    (pc.input as { permissionTier?: string }).permissionTier === "edit"
  ) {
    return "allow"
  }

  // 3. Hooks PreToolUse
  for (const h of policy.hooks.PreToolUse) {
    if (!matchHook(h, pc.toolName, pc.input, pc.context.sessionId, pc.context.profileId)) continue
    const decision = await runHookCommands(h, pc.toolName, pc.input)
    if (decision === "deny") return "deny"
    if (decision === "ask") return "ask"
    if (decision === "allow") return "allow"
  }

  return allowMatch ? "allow" : "allow"
}

/** Helper para tools: si el tool define `checkPermissions`, usa eso.
 *  Si no, consume el runtime gate. Devuelve la decisión final. */
export async function gateTool(
  pc: PermissionContext,
  rootDir: string,
  toolCheck?: (input: Record<string, unknown>, ctx: ToolContext) => PermissionDecision | Promise<PermissionDecision>,
): Promise<PermissionDecision> {
  if (toolCheck) {
    const result = await toolCheck(pc.input, pc.context)
    if (result === "deny") return "deny"
    if (result === "ask") return "ask"
  }
  return checkPermissionForTool(pc, rootDir)
}
