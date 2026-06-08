// Pipeline segmentation: per-segment check de commands pipe-separated.
// FC parity: extraído de bashCommandHelpers.ts. Detecta cross-segment cd+git,
// all-allowed/all-denied aggregation.

import { parseBashCommand, type CommandSegment, type ParsedCommand } from "./parseForSecurity.ts"

export type SegmentDecision = "allow" | "ask" | "deny"

export type SegmentResult = {
  segment: CommandSegment
  decision: SegmentDecision
  reason?: string
}

export type PipelineResult = {
  segments: SegmentResult[]
  /** Decisión agregada del pipeline entero. */
  aggregated: SegmentDecision
  /** ¿Hay un cross-segment cd+git chain (sospechoso de redirección maliciosa)? */
  hasCdGitChain: boolean
}

/** Evalúa un pipeline de segments. */
export function evaluatePipeline(
  parsed: ParsedCommand,
  perSegment: (segment: CommandSegment) => SegmentResult,
): PipelineResult {
  const results = parsed.segments.map(perSegment)
  // Detección cross-segment cd+git
  const hasCdGitChain = detectCdGitChain(parsed.segments)
  // Agregación
  let aggregated: SegmentDecision = "allow"
  for (const r of results) {
    if (r.decision === "deny") {
      aggregated = "deny"
      break
    }
    if (r.decision === "ask") {
      aggregated = "ask"
    }
  }
  return { segments: results, aggregated, hasCdGitChain }
}

/** Detecta pattern: `cd dir && git ...` (cross-segment) */
export function detectCdGitChain(segments: CommandSegment[]): boolean {
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].startsWithCd) {
      // Buscar el siguiente segment que sea git
      for (let j = i + 1; j < segments.length; j++) {
        if (segments[j].isGitCommand) {
          return true
        }
        if (segments[j].argv.length > 0) {
          break
        }
      }
    }
  }
  return false
}

/** Check early-exit deny: un segmento con deny bloquea el pipeline entero. */
export function checkEarlyExitDeny(results: SegmentResult[]): SegmentDecision {
  for (const r of results) {
    if (r.decision === "deny") return "deny"
  }
  return "allow"
}

/** Check semantics deny: basado en command semantics (no implementado en MVP). */
export function checkSemanticsDeny(segments: CommandSegment[]): SegmentDecision {
  // FC tiene lógica compleja basada en commandSemantics. Por ahora no-op.
  return "allow"
}

/** Split de un command crudo en segments con parseBashCommand. */
export function splitAndParse(command: string): ParsedCommand {
  return parseBashCommand(command)
}
