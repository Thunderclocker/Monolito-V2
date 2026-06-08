// Bash permission rules machinery: matchWildcardPattern, stripWrappers, etc.
// FC parity: extraído de bashPermissions.ts de upstream, simplificado.

import type { CommandSegment } from "./parseForSecurity.ts"

/** Match glob pattern (FC usa minimatch-like syntax). */
export function matchWildcardPattern(pattern: string, value: string): boolean {
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

/** Extrae el prefijo antes de un here-doc. */
export function extractPrefixBeforeHeredoc(command: string): string | null {
  const idx = command.indexOf("<<")
  if (idx === -1) return null
  return command.slice(0, idx).trim()
}

/** Variables peligrosas que pueden secuestrar la ejecución. */
export const BINARY_HIJACK_VARS = /^(LD_|DYLD_|PATH$)/

/** Env vars seguros para preservar. */
export const SAFE_ENV_VARS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL",
  "TZ", "PWD", "OLDPWD", "HOSTNAME", "USER", "EDITOR", "VISUAL", "PAGER",
])

/** Strip env-var assignments del inicio de un argv. */
export function stripAllLeadingEnvVars(argv: string[]): { stripped: string[]; vars: Record<string, string> } {
  const vars: Record<string, string> = {}
  const stripped: string[] = []
  let i = 0
  while (i < argv.length) {
    const m = argv[i].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) {
      vars[m[1]] = m[2]
      i++
      continue
    }
    break
  }
  while (i < argv.length) stripped.push(argv[i++])
  return { stripped, vars }
}

/** Strip wrappers de un argv (env, sudo, nice, nohup, timeout, command). */
export function stripWrappersFromArgv(argv: string[]): string[] {
  const WRAPPERS = new Set(["env", "sudo", "nice", "nohup", "timeout", "command"])
  let i = 0
  while (i < argv.length && WRAPPERS.has(argv[i])) {
    if (argv[i] === "timeout") {
      // skip timeout and its numeric arg
      i++
      if (i < argv.length && /^\d+[smhd]?$/.test(argv[i])) i++
    } else if (argv[i] === "env") {
      // skip env and its env-var assignments
      i++
      while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i++
    } else {
      i++
    }
  }
  return argv.slice(i)
}

/** Strip líneas de comentario (que empiezan con #) de un command multi-línea. */
export function stripCommentLines(command: string): string {
  return command
    .split("\n")
    .map(line => {
      const idx = line.indexOf("#")
      if (idx === -1) return line
      // Verificar que # no esté dentro de quotes
      let inSingle = false
      let inDouble = false
      for (let i = 0; i < idx; i++) {
        const ch = line[i]
        if (ch === "'" && !inDouble) inSingle = !inSingle
        if (ch === '"' && !inSingle) inDouble = !inDouble
      }
      if (inSingle || inDouble) return line
      return line.slice(0, idx)
    })
    .join("\n")
}

/** Detecta si un pattern es seguro según BINARY_HIJACK_VARS. */
export function hasBinaryHijackVar(vars: Record<string, string>): boolean {
  for (const key of Object.keys(vars)) {
    if (BINARY_HIJACK_VARS.test(key)) return true
  }
  return false
}

/** Detecta command substitution no-quoted en un comando. */
export function hasUnquotedCommandSubstitution(command: string): boolean {
  return /\$\(/.test(command) || /`[^`]+`/.test(command)
}

/** Strip safe wrappers (los que no son peligrosos). Equivalente a stripWrappersFromArgv
 *  pero más permisivo (no remueve sudo, etc). */
export function stripSafeWrappers(argv: string[]): string[] {
  // Por ahora mismo comportamiento que stripWrappersFromArgv; FC lo diferencia
  // según contexto (modeValidation.ts).
  return stripWrappersFromArgv(argv)
}

/** Filter rules by contents matching input. */
export function filterRulesByContentsMatchingInput(
  rules: Array<{ tool?: string; action: string; input?: string }>,
  toolName: string,
  input: Record<string, unknown>,
): Array<{ tool?: string; action: string; input?: string }> {
  return rules.filter(rule => {
    if (rule.tool && !matchWildcardPattern(rule.tool, toolName)) return false
    if (rule.input) {
      try {
        const re = new RegExp(rule.input)
        const haystack = JSON.stringify(input)
        if (!re.test(haystack)) return false
      } catch {
        return false
      }
    }
    return true
  })
}

/** Verifica si un segment es "read-only" según allowlist. */
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "stat", "file",
  "strings", "find", "grep", "rg", "ag", "awk", "cut", "sort", "uniq",
  "tr", "diff", "cmp", "md5sum", "sha1sum", "sha256sum", "wc", "echo",
  "printf", "true", "false", ":", "pwd", "whoami", "date", "which",
  "type", "command", "hash", "test", "[", "jq", "yq",
])

export function isReadOnlyCommand(segment: { argv: string[]; hasRedirection: boolean }): boolean {
  if (!segment || !segment.argv || segment.argv.length === 0) return false
  const cmd = segment.argv[0]
  if (!READ_ONLY_COMMANDS.has(cmd)) return false
  // No debe tener redirections
  if (segment.hasRedirection) return false
  return true
}
