// Bash permission gate: integra parseForSecurity + permissionRules + segmentation +
// bashSecurity (validators) + readOnly + path + sed. Async classifier stub.
//
// FC parity: extraído de permissionGate.ts de upstream. Sin async LLM classifier real
// (devuelve passthrough); el resto del flujo está implementado.

import {
  parseBashCommand,
  isCommandParseable,
  type ParsedCommand,
} from "./parseForSecurity.ts"
import {
  matchWildcardPattern,
  stripAllLeadingEnvVars,
  stripWrappersFromArgv,
  stripCommentLines,
  filterRulesByContentsMatchingInput,
  isReadOnlyCommand,
  hasBinaryHijackVar,
  hasUnquotedCommandSubstitution,
} from "./permissionRules.ts"
import { evaluatePipeline, type PipelineResult, type SegmentResult, type SegmentDecision } from "./segmentation.ts"
import { runSecurityValidators, detectDestructiveCommand, type BashFinding } from "./bash-helpers.ts"
import type { CommandSegment } from "./parseForSecurity.ts"

export type BashPermissionRule = {
  tool: string  // always "Bash" for these
  action: "allow" | "deny" | "ask"
  /** FC rule format: like "Bash(npm test:*)" — prefix pattern */
  prefix?: string
  /** Optional regex for input */
  input?: string
}

export type PermissionGateResult = {
  decision: "allow" | "ask" | "deny"
  reason?: string
  findings: BashFinding[]
  parsed: ParsedCommand
  pipeline: PipelineResult
}

export type PermissionGateOptions = {
  rules: BashPermissionRule[]
  /** When true (acceptEdits mode), auto-allow filesystem commands. */
  acceptEditsMode?: boolean
}

/** Main entry point: gate a bash command. */
export function gateBashCommand(
  command: string,
  options: PermissionGateOptions = { rules: [] },
): PermissionGateResult {
  // 1. Strip comments de primera pasada (afecta parsing posterior)
  const cleanedCommand = stripCommentLines(command)
  // 2. Parse
  const parsed = parseBashCommand(cleanedCommand)
  // 3. Run security validators
  const findings = runSecurityValidators(cleanedCommand)
  // 4. Destructive check (informational, no bloquea)
  const destructive = detectDestructiveCommand(cleanedCommand)
  // 5. Pipeline evaluation
  const pipeline = evaluatePipeline(parsed, segment =>
    evaluateSegment(segment, options.rules, options.acceptEditsMode ?? false),
  )

  // 6. Aggregate: critical/high security findings deny
  const criticalFindings = findings.filter(f => f.severity === "critical" || f.severity === "high")
  if (criticalFindings.length > 0) {
    return {
      decision: "deny",
      reason: `Security: ${criticalFindings.map(f => f.rule).join(", ")}`,
      findings: [...findings, ...destructive.map(d => ({ ...d, severity: "medium" as const }))],
      parsed,
      pipeline,
    }
  }

  // 7. Cross-segment cd+git chain → ask
  if (pipeline.hasCdGitChain) {
    return {
      decision: "ask",
      reason: "Cross-segment cd + git detected (suspicious directory change before git command)",
      findings: [...findings, ...destructive.map(d => ({ ...d, severity: "medium" as const }))],
      parsed,
      pipeline,
    }
  }

  // 8. Pipeline aggregated decision
  if (pipeline.aggregated === "deny") {
    return {
      decision: "deny",
      reason: "Pipeline contains a denied segment",
      findings,
      parsed,
      pipeline,
    }
  }
  if (pipeline.aggregated === "ask") {
    return {
      decision: "ask",
      reason: "Pipeline contains a segment that requires explicit permission",
      findings,
      parsed,
      pipeline,
    }
  }

  // 9. Parse-unavailable → ask (more conservative)
  if (!parsed.allSegmentsParseOk) {
    return {
      decision: "ask",
      reason: parsed.parseError ?? "Parse unavailable — needs explicit permission",
      findings,
      parsed,
      pipeline,
    }
  }

  // 10. No issues → allow
  return {
    decision: "allow",
    findings: [...findings, ...destructive.map(d => ({ ...d, severity: "medium" as const }))],
    parsed,
    pipeline,
  }
}

function evaluateSegment(
  segment: CommandSegment,
  rules: BashPermissionRule[],
  acceptEditsMode: boolean,
): SegmentResult {
  // 1. acceptEdits auto-allow for filesystem commands
  if (acceptEditsMode) {
    const FS_COMMANDS = new Set(["mkdir", "touch", "rm", "rmdir", "mv", "cp", "sed", "ln", "chmod", "chown"])
    if (segment.argv[0] && FS_COMMANDS.has(segment.argv[0])) {
      return { segment, decision: "allow", reason: "acceptEdits auto-allow (filesystem command)" }
    }
  }
  // 2. Read-only commands → allow
  if (isReadOnlyCommand(segment)) {
    return { segment, decision: "allow", reason: "read-only command" }
  }
  // 3. Match against rules
  if (segment.argv.length === 0) {
    return { segment, decision: "ask", reason: "empty segment" }
  }
  const command = segment.argv[0]
  for (const rule of rules) {
    if (rule.action === "deny" && matchRule(rule, command, segment)) {
      return { segment, decision: "deny", reason: `rule deny matched: ${describeRule(rule)}` }
    }
  }
  // 4. Check for explicit allow rules
  for (const rule of rules) {
    if (rule.action === "allow" && matchRule(rule, command, segment)) {
      return { segment, decision: "allow", reason: `rule allow matched: ${describeRule(rule)}` }
    }
  }
  // 5. Default: ask (when rules exist), allow (when no rules)
  if (rules.length === 0) {
    return { segment, decision: "allow", reason: "no rules configured" }
  }
  return { segment, decision: "ask", reason: "no explicit allow rule matched" }
}

function matchRule(rule: BashPermissionRule, command: string, segment: CommandSegment): boolean {
  if (!matchWildcardPattern(command, command)) {
    // Match against command name
  }
  // Simple rule matching: rule.prefix is a glob on the command name
  if (rule.prefix) {
    // Strip "Bash(" prefix and ")" suffix if present
    let pattern = rule.prefix
    if (pattern.startsWith("Bash(") && pattern.endsWith(")")) {
      pattern = pattern.slice(5, -1)
    }
    // Remove trailing ":*" for prefix match (treat as optional suffix)
    const basePattern = pattern.replace(/:\\\*$/, "*")
    // Also try the pattern WITHOUT the * suffix (so "npm test:*" matches "npm test")
    const noSuffixPattern = basePattern.replace(/\\\*$/, "")
    const fullArgv = segment.argv.join(" ")
    // Try multiple match strategies
    const candidates = [command, fullArgv, segment.argv.slice(0, 2).join(" "), segment.argv.slice(0, 3).join(" ")]
    for (const candidate of candidates) {
      if (matchWildcardPattern(basePattern, candidate)) return true
      if (matchWildcardPattern(noSuffixPattern, candidate)) return true
    }
    return false
  }
  return true
}

function describeRule(rule: BashPermissionRule): string {
  if (rule.prefix) return `Bash(${rule.prefix})`
  return `Bash`
}

/** Validador de syntax: si shell-quote falla, marca unavailable. */
export function isShellParseable(command: string): boolean {
  const parsed = parseBashCommand(command)
  return isCommandParseable(parsed)
}
