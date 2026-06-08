// Bash AST parser: envuelve shell-quote.parse con detección de parse-unavailable,
// subset parser de pipes, subshells, redirects, command groups.
//
// FC parity: extraído de parseForSecurity de upstream. Sin tree-sitter (opcional
// detrás de feature flag MONOLITO_BASH_AST_TREE_SITTER=1, no activado por defecto).
//
// Estrategia:
//   1. shell-quote.parse(command) — devuelve array de tokens
//   2. Si shell-quote tira error, marcamos "parse-unavailable" (más conservador)
//   3. Si pasa, parseamos los operators (|, &&, ||, ;, &, $(), redirections)
//   4. Devolvemos una estructura Command con segments

// @ts-expect-error shell-quote lacks types
import { parse as shellQuoteParse } from "shell-quote"

export type CommandSegment = {
  /** Tokens con environment variable assignments prefix stripped. */
  argv: string[]
  /** Wrappers detectados (env, sudo, nice, nohup, timeout, command, xargs). */
  wrappers: string[]
  /** ¿Contiene redirections? */
  hasRedirection: boolean
  /** ¿Contiene subshell ($() o backticks)? */
  hasSubshell: boolean
  /** ¿Contiene process substitution? */
  hasProcessSubstitution: boolean
  /** ¿Comienza con cd? */
  startsWithCd: boolean
  /** ¿Es un comando git? */
  isGitCommand: boolean
  /** ¿Comando parseado o "unavailable"? */
  parseStatus: "ok" | "unavailable"
  /** Error message si parseStatus = unavailable. */
  parseError?: string
}

export type ParsedCommand = {
  /** Pipe-separated segments. */
  segments: CommandSegment[]
  /** ¿Contiene operadores lógicos (&&, ||, ;)? */
  hasLogicalOperators: boolean
  /** ¿Contiene backgrounding (&)? */
  hasBackground: boolean
  /** ¿Contiene redirections en algún segmento? */
  hasRedirection: boolean
  /** ¿Contiene process substitution? */
  hasProcessSubstitution: boolean
  /** ¿Contiene subshells? */
  hasSubshell: boolean
  /** ¿Todos los segmentos se parsearon OK? */
  allSegmentsParseOk: boolean
  /** Si algún segmento falló, devuelve "unavailable" + mensaje. */
  parseError?: string
}

const WRAPPER_COMMANDS = new Set([
  "env", "sudo", "nice", "nohup", "timeout", "command", "xargs",
])

const REDIRECTION_OPS = new Set([
  ">", "<", ">>", "<<", ">&", "<&", ">|", "<>", ">>|",
])

/** Parsea un command bash en segments. */
export function parseBashCommand(command: string): ParsedCommand {
  // Split inicial en segments via operators (|, &&, ||, ;, &) — fuera de quotes/parens.
  // shell-quote no hace esto, así que hacemos nuestro propio split de primera pasada.
  const rawSegments = splitOnTopLevelOperators(command)
  const segments: CommandSegment[] = []
  let allOk = true
  let firstError: string | undefined

  for (const raw of rawSegments) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const seg = parseSegment(trimmed)
    if (seg.parseStatus === "unavailable") {
      allOk = false
      if (!firstError) firstError = seg.parseError
    }
    segments.push(seg)
  }

  const hasLogicalOperators = /[;&]/.test(command)
  const hasBackground = /(?<!\\)&(?![&|=])/.test(command)
  const hasRedirection = segments.some(s => s.hasRedirection)
  const hasSubshell = segments.some(s => s.hasSubshell)
  const hasProcessSubstitution = segments.some(s => s.hasProcessSubstitution)

  const result: ParsedCommand = {
    segments,
    hasLogicalOperators,
    hasBackground,
    hasRedirection,
    hasProcessSubstitution,
    hasSubshell,
    allSegmentsParseOk: allOk,
  }
  if (firstError) result.parseError = firstError
  return result
}

/** Split de primera pasada en top-level operators. */
function splitOnTopLevelOperators(command: string): string[] {
  const result: string[] = []
  let buf = ""
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      buf += ch
      if (ch === quote && command[i - 1] !== "\\") quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      buf += ch
      continue
    }
    if (ch === "(" || ch === "{") {
      depth++
      buf += ch
      continue
    }
    if (ch === ")" || ch === "}") {
      depth--
      buf += ch
      continue
    }
    if (depth === 0) {
      if (ch === "|" || ch === ";" || ch === "&") {
        // Solo operadores top-level (no |, & dentro de pipes/background)
        if (ch === "|" && command[i + 1] === "|") {
          // || — logical OR
          result.push(buf)
          buf = ""
          i++ // skip next |
          continue
        }
        if (ch === "&" && command[i + 1] === "&") {
          // && — logical AND
          result.push(buf)
          buf = ""
          i++
          continue
        }
        if (ch === "|" || ch === ";" || ch === "&") {
          result.push(buf)
          buf = ""
          continue
        }
      }
    }
    buf += ch
  }
  if (buf) result.push(buf)
  return result
}

/** Parsea un segmento individual. */
function parseSegment(segment: string): CommandSegment {
  let argv: any[]
  try {
    argv = shellQuoteParse(segment) as any[]
  } catch (e) {
    return {
      argv: [],
      wrappers: [],
      hasRedirection: false,
      hasSubshell: false,
      hasProcessSubstitution: false,
      startsWithCd: false,
      isGitCommand: false,
      parseStatus: "unavailable",
      parseError: e instanceof Error ? e.message : String(e),
    }
  }

  // Normalizar: shell-quote devuelve operators como strings separados, comments como {comment}
  // o glob patterns. Convertir a flat string array, descartar comments y globs complejos.
  const tokens: string[] = []
  const wrappers: string[] = []
  let hasRedirection = false
  let hasSubshell = false
  let hasProcessSubstitution = false

  for (const item of argv) {
    if (typeof item === "string") {
      tokens.push(item)
    } else if (item && typeof item === "object" && "op" in item) {
      // Operator (>, <, etc) — marca redirection
      hasRedirection = true
    } else if (item && typeof item === "object" && "pattern" in item) {
      // Glob pattern
      tokens.push(item.pattern as string)
    }
  }

  // Strip env var assignments prefix (KEY=val)
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    tokens.shift()
  }

  // Detect wrappers
  while (tokens.length > 0 && WRAPPER_COMMANDS.has(tokens[0])) {
    wrappers.push(tokens[0])
    tokens.shift()
  }

  // Detect additional wrappers in the chain (e.g. "sudo env VAR=x")
  // (Simplificado: solo strip primera capa)

  // Detect subshells / process substitution en la string original
  hasSubshell = /\$[(]/.test(segment) || /`/.test(segment)
  hasProcessSubstitution = /<\(|\>\(/.test(segment)

  // Detect cd / git
  const startsWithCd = tokens[0] === "cd"
  const isGitCommand = tokens[0] === "git"

  return {
    argv: tokens,
    wrappers,
    hasRedirection,
    hasSubshell,
    hasProcessSubstitution,
    startsWithCd,
    isGitCommand,
    parseStatus: "ok",
  }
}

/** Devuelve true si el comando entero se parseó OK. */
export function isCommandParseable(parsed: ParsedCommand): boolean {
  return parsed.allSegmentsParseOk
}

/** Extrae el primer comando de cada segment (sin wrappers, sin env vars). */
export function getCommandNames(parsed: ParsedCommand): string[] {
  return parsed.segments.map(s => s.argv[0]).filter((c): c is string => typeof c === "string")
}
