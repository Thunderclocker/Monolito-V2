// Bash helpers: destructive command detection + core security validators.
// Subset del bashSecurity de upstream reference (12 de 25).
//
// Análisis de seguridad por omission:
//   Cobertura (12 validators): control chars, IFS injection, mid-word hash,
//   brace expansion, backslash escape, unicode whitespace, dangerous patterns
//   core, shell metachars, redirections, newlines, backslash escaped operators,
//   dangerous variables.
//   Lo que NO se cubre (decisión consciente para v1):
//   - Comentario-quote desync (raro, requiere parser)
//   - Quoted newlines (subcaso de newlines)
//   - CR injection (cubierto parcialmente por control chars)
//   - Heredoc malicioso (cubierto por dangerous patterns)

export type BashFinding = {
  rule: string
  severity: "low" | "medium" | "high" | "critical"
  description: string
  position: number
}

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\brm\s+(-\w*r\w*\s+)*(-\w*f\w*\s+)*[\/~]/i, description: "rm -rf on absolute path" },
  { pattern: /\bgit\s+(reset|clean|checkout|restore|stash\s+drop)\s+.*--hard/i, description: "git hard reset/clean/checkout" },
  { pattern: /\bgit\s+push\s+.*--force/i, description: "git push --force" },
  { pattern: /\bgit\s+push\s+-f\b/i, description: "git push -f" },
  { pattern: /\bDDROP\s+TABLE\b/i, description: "DROP TABLE" },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, description: "TRUNCATE TABLE" },
  { pattern: /\bDELETE\s+FROM\b/i, description: "DELETE FROM (without WHERE)" },
  { pattern: /\bkubectl\s+delete\b/i, description: "kubectl delete" },
  { pattern: /\bterraform\s+destroy\b/i, description: "terraform destroy" },
  { pattern: /:\s*\(\s*\)\s*\{.*:\|:&\s*\}\s*;/, description: "fork bomb" },
]

export function detectDestructiveCommand(command: string): BashFinding[] {
  const findings: BashFinding[] = []
  for (const { pattern, description } of DESTRUCTIVE_PATTERNS) {
    const m = command.match(pattern)
    if (m && m.index !== undefined) {
      findings.push({
        rule: "destructive",
        severity: "high",
        description,
        position: m.index,
      })
    }
  }
  return findings
}

// 12 security validators

/** V1: control chars que no deberían estar en un shell command. */
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
export function hasControlChars(command: string): BashFinding[] {
  const m = command.match(CONTROL_CHARS)
  if (m && m.index !== undefined) {
    return [{ rule: "control_chars", severity: "critical", description: "control char in command", position: m.index }]
  }
  return []
}

/** V2: IFS injection via env var override (e.g., IFS=$'\n' command). */
const IFS_INJECTION = /\bIFS\s*=\s*['"]?[^'"]*[\$\\][^'"]*['"]?/
export function hasIfsInjection(command: string): BashFinding[] {
  const m = command.match(IFS_INJECTION)
  if (m && m.index !== undefined) {
    return [{ rule: "ifs_injection", severity: "high", description: "IFS override detected", position: m.index }]
  }
  return []
}

/** V3: mid-word hash that could be a shebang inside an arg. */
const MID_WORD_HASH = /[^/]\s*#\s*!/
export function hasMidWordHash(command: string): BashFinding[] {
  const m = command.match(MID_WORD_HASH)
  if (m && m.index !== undefined) {
    return [{ rule: "mid_word_hash", severity: "medium", description: "mid-word shebang-like", position: m.index }]
  }
  return []
}

/** V4: brace expansion. */
const BRACE_EXPANSION = /\{[a-zA-Z0-9,._-]+\}/
export function hasBraceExpansion(command: string): BashFinding[] {
  const m = command.match(BRACE_EXPANSION)
  if (m && m.index !== undefined) {
    return [{ rule: "brace_expansion", severity: "low", description: "brace expansion present", position: m.index }]
  }
  return []
}

/** V5: backslash escape at end of line. */
const BACKSLASH_ESCAPE = /\\\s*$/
export function hasBackslashEscape(command: string): BashFinding[] {
  const m = command.match(BACKSLASH_ESCAPE)
  if (m && m.index !== undefined) {
    return [{ rule: "backslash_escape", severity: "medium", description: "backslash at end of line", position: m.index }]
  }
  return []
}

/** V6: unicode whitespace que podría usarse para evasion. */
const UNICODE_WHITESPACE = /[\u00a0\u2000-\u200b\u2028\u2029\u3000]/u
export function hasUnicodeWhitespace(command: string): BashFinding[] {
  const m = command.match(UNICODE_WHITESPACE)
  if (m && m.index !== undefined) {
    return [{ rule: "unicode_whitespace", severity: "high", description: "unicode whitespace detected", position: m.index }]
  }
  return []
}

/** V7: dangerous patterns core (curl|sh, wget|sh, eval of unquoted vars). */
const DANGEROUS_PATTERNS_CORE = [
  /\bcurl\b[^\n]*\|\s*(?:sh|bash|zsh|sudo\s+sh)/i,
  /\bwget\b[^\n]*\|\s*(?:sh|bash|zsh|sudo\s+sh)/i,
  /\beval\s+["']?\$\(/i,
]
export function hasDangerousPatternsCore(command: string): BashFinding[] {
  const findings: BashFinding[] = []
  for (const p of DANGEROUS_PATTERNS_CORE) {
    const m = command.match(p)
    if (m && m.index !== undefined) {
      findings.push({
        rule: "dangerous_pattern",
        severity: "critical",
        description: `dangerous pattern: ${m[0].slice(0, 40)}`,
        position: m.index,
      })
    }
  }
  return findings
}

/** V8: shell metacharacters that bypass quoting. */
const SHELL_METACHARS = /[\$\(\)\{\}\[\]<>|&;`\\]/
export function hasShellMetachars(command: string): BashFinding[] {
  // Esta es solo informativa — no bloquea
  const m = command.match(SHELL_METACHARS)
  if (m && m.index !== undefined) {
    return [{
      rule: "shell_metachars",
      severity: "low",
      description: "shell metachars present (review for intent)",
      position: m.index,
    }]
  }
  return []
}

/** V9: redirections to sensitive paths. */
const DANGEROUS_REDIRECT = />\s*(\/etc\/|\/System\/|~?\/\.ssh\/|~\/\.bashrc|~\/\.profile)/
export function hasDangerousRedirection(command: string): BashFinding[] {
  const m = command.match(DANGEROUS_REDIRECT)
  if (m && m.index !== undefined) {
    return [{
      rule: "dangerous_redirection",
      severity: "high",
      description: `redirection to ${m[1]}`,
      position: m.index,
    }]
  }
  return []
}

/** V10: embedded newlines (command injection vector). */
const EMBEDDED_NEWLINE = /\n/
export function hasEmbeddedNewline(command: string): BashFinding[] {
  const m = command.match(EMBEDDED_NEWLINE)
  if (m && m.index !== undefined) {
    return [{
      rule: "embedded_newline",
      severity: "medium",
      description: "embedded newline in command",
      position: m.index,
    }]
  }
  return []
}

/** V11: backslash-escaped operators (`\n`, `\t`, `\$`). */
const ESCAPED_OPERATORS_RE = /\\[ntr\$\(\)\{\}\[\]]/
export function hasEscapedOperator(command: string): BashFinding[] {
  const m = command.match(ESCAPED_OPERATORS_RE)
  if (m && m.index !== undefined) {
    return [{
      rule: "escaped_operator",
      severity: "medium",
      description: "backslash-escaped operator (possible injection)",
      position: m.index,
    }]
  }
  return []
}

/** V12: dangerous variables (LD_PRELOAD, DYLD_INSERT_LIBRARIES, PATH). */
const DANGEROUS_VARS = /\b(LD_PRELOAD|DYLD_INSERT_LIBRARIES|DYLD_FORCE_FLAT_NAMESPACE|PATH)\s*=\s*[^"';\n\s]/
export function hasDangerousVariable(command: string): BashFinding[] {
  const m = command.match(DANGEROUS_VARS)
  if (m && m.index !== undefined) {
    return [{
      rule: "dangerous_variable",
      severity: "high",
      description: `dangerous var override: ${m[1]}`,
      position: m.index,
    }]
  }
  return []
}

// V13: comment-quote desync — `#` que aparece sospechoso cerca de quotes
const COMMENT_QUOTE_DESYNC = /'\s*#|\s'\s*#/
export function hasCommentQuoteDesync(command: string): BashFinding[] {
  const m = command.match(COMMENT_QUOTE_DESYNC)
  if (m && m.index !== undefined) {
    return [{ rule: "comment_quote_desync", severity: "medium", description: "potential comment-quote desync", position: m.index }]
  }
  return []
}

// V14: quoted newlines dentro de strings — pueden esconder código
const QUOTED_NEWLINE = /'(?:\\n|\\r|\\t)'/
export function hasQuotedNewline(command: string): BashFinding[] {
  const m = command.match(QUOTED_NEWLINE)
  if (m && m.index !== undefined) {
    return [{ rule: "quoted_newline", severity: "medium", description: "quoted newline escape (possible hidden code)", position: m.index }]
  }
  return []
}

// V15: CR (carriage return) injection
const CR_INJECTION = /\r/
export function hasCrInjection(command: string): BashFinding[] {
  const m = command.match(CR_INJECTION)
  if (m && m.index !== undefined) {
    return [{ rule: "cr_injection", severity: "medium", description: "carriage return detected (possible CRLF injection)", position: m.index }]
  }
  return []
}

// V16: heredoc malicioso (<<EOF con código adentro)
const HEREDOC_PATTERN = /<<\s*['"]?(\w+)['"]?/
export function hasHeredocInjection(command: string): BashFinding[] {
  const m = command.match(HEREDOC_PATTERN)
  if (m && m.index !== undefined) {
    // Heredoc solo es sospechoso si el delimiter no está quoted
    if (!/['"]/.test(command.slice(m.index, m.index + m[0].length))) {
      return [{ rule: "heredoc_injection", severity: "medium", description: `heredoc with unquoted delimiter: ${m[1]}`, position: m.index }]
    }
  }
  return []
}

// V17: env vars que apuntan a /tmp o /dev (sospechoso de LD_PRELOAD attack)
const SUSPICIOUS_ENV_PATH = /\b\w+\s*=\s*['"]?\/(tmp|dev)\b/
export function hasSuspiciousEnvPath(command: string): BashFinding[] {
  const m = command.match(SUSPICIOUS_ENV_PATH)
  if (m && m.index !== undefined) {
    return [{ rule: "suspicious_env_path", severity: "high", description: `env var points to suspicious path: ${m[0]}`, position: m.index }]
  }
  return []
}

// V18: process substitution con /dev/fd (file descriptor injection)
const PROC_SUBST_FD = /<\(|\>\(/
export function hasProcSubstFD(command: string): BashFinding[] {
  const m = command.match(PROC_SUBST_FD)
  if (m && m.index !== undefined) {
    return [{ rule: "proc_subst_fd", severity: "low", description: "process substitution <() or >()", position: m.index }]
  }
  return []
}

// V19: fork bomb (ya cubierto por destructive pero agregamos como validator)
const FORK_BOMB = /:\s*\(\s*\)\s*\{.*:\|:&\s*\}\s*;/
export function hasForkBomb(command: string): BashFinding[] {
  const m = command.match(FORK_BOMB)
  if (m && m.index !== undefined) {
    return [{ rule: "fork_bomb", severity: "critical", description: "fork bomb pattern detected", position: m.index }]
  }
  return []
}

// V20: shebang dentro de argumento (puede ser intento de bypass)
const SHEBANG_IN_ARG = /#!(?:\/bin\/(?:ba)?sh|env)/
export function hasShebangInArg(command: string): BashFinding[] {
  const m = command.match(SHEBANG_IN_ARG)
  if (m && m.index !== undefined) {
    return [{ rule: "shebang_in_arg", severity: "medium", description: `shebang in command: ${m[0]}`, position: m.index }]
  }
  return []
}

// V21: cd .. múltiples (path traversal)
const MULTI_CD_UP = /cd\s+\.\.(?:\s*;\s*cd\s+\.\.){2,}/
export function hasMultiCdUp(command: string): BashFinding[] {
  const m = command.match(MULTI_CD_UP)
  if (m && m.index !== undefined) {
    return [{ rule: "multi_cd_up", severity: "medium", description: "multiple cd .. (path traversal)", position: m.index }]
  }
  return []
}

// V22: chmod 777 (world-writable)
const CHMOD_777 = /\bchmod\s+(?:-\w+\s+)*7{3}/
export function hasChmod777(command: string): BashFinding[] {
  const m = command.match(CHMOD_777)
  if (m && m.index !== undefined) {
    return [{ rule: "chmod_777", severity: "medium", description: "chmod 777 (world-writable)", position: m.index }]
  }
  return []
}

// V23: find con -exec (puede ejecutar cosas)
const FIND_EXEC = /\bfind\b[^\n]*-exec\b/
export function hasFindExec(command: string): BashFinding[] {
  const m = command.match(FIND_EXEC)
  if (m && m.index !== undefined) {
    return [{ rule: "find_exec", severity: "low", description: "find -exec (review for safety)", position: m.index }]
  }
  return []
}

// V24: xargs con rm o mv
const XARGS_DANGEROUS = /\bxargs\s+(?:-\w+\s+)*(rm|mv|dd|shred|chmod)/
export function hasXargsDangerous(command: string): BashFinding[] {
  const m = command.match(XARGS_DANGEROUS)
  if (m && m.index !== undefined) {
    return [{ rule: "xargs_dangerous", severity: "high", description: `xargs with dangerous command: ${m[1]}`, position: m.index }]
  }
  return []
}

// V25: base64 decode + execute (common obfuscation)
const BASE64_EXEC = /base64\s+(?:-d|--decode)[^\n]*\|\s*(?:sh|bash|zsh|source)/
export function hasBase64Exec(command: string): BashFinding[] {
  const m = command.match(BASE64_EXEC)
  if (m && m.index !== undefined) {
    return [{ rule: "base64_exec", severity: "critical", description: "base64 decode piped to shell", position: m.index }]
  }
  return []
}

const ALL_VALIDATORS: Array<{ name: string; fn: (cmd: string) => BashFinding[] }> = [
  { name: "control_chars", fn: hasControlChars },
  { name: "ifs_injection", fn: hasIfsInjection },
  { name: "mid_word_hash", fn: hasMidWordHash },
  { name: "brace_expansion", fn: hasBraceExpansion },
  { name: "backslash_escape", fn: hasBackslashEscape },
  { name: "unicode_whitespace", fn: hasUnicodeWhitespace },
  { name: "dangerous_pattern", fn: hasDangerousPatternsCore },
  { name: "shell_metachars", fn: hasShellMetachars },
  { name: "dangerous_redirection", fn: hasDangerousRedirection },
  { name: "embedded_newline", fn: hasEmbeddedNewline },
  { name: "escaped_operator", fn: hasEscapedOperator },
  { name: "dangerous_variable", fn: hasDangerousVariable },
  { name: "comment_quote_desync", fn: hasCommentQuoteDesync },
  { name: "quoted_newline", fn: hasQuotedNewline },
  { name: "cr_injection", fn: hasCrInjection },
  { name: "heredoc_injection", fn: hasHeredocInjection },
  { name: "suspicious_env_path", fn: hasSuspiciousEnvPath },
  { name: "proc_subst_fd", fn: hasProcSubstFD },
  { name: "fork_bomb", fn: hasForkBomb },
  { name: "shebang_in_arg", fn: hasShebangInArg },
  { name: "multi_cd_up", fn: hasMultiCdUp },
  { name: "chmod_777", fn: hasChmod777 },
  { name: "find_exec", fn: hasFindExec },
  { name: "xargs_dangerous", fn: hasXargsDangerous },
  { name: "base64_exec", fn: hasBase64Exec },
]

export function runSecurityValidators(command: string): BashFinding[] {
  const findings: BashFinding[] = []
  for (const { fn } of ALL_VALIDATORS) {
    findings.push(...fn(command))
  }
  return findings
}
