type RecoveryStrategy = {
  key: string
  instruction: string
}

export type ToolFailureRecord = {
  tool: string
  input: Record<string, unknown>
  error?: string
}

export type RecoveryState = {
  goal: string
  maxAttempts: number
  attempts: number
  attemptedStrategyKeys: string[]
  exhausted: boolean
}

export type ToolRecoveryPlan = {
  prompt: string
  exhausted: boolean
  remainingAttempts: number
  attemptedStrategyKeys: string[]
}

const DEFAULT_MAX_ATTEMPTS = 4
const SUBAGENT_MAX_ATTEMPTS = 3

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function clip(value: string, max = 300) {
  const normalized = compactWhitespace(value)
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3)}...`
}

function extractPathCandidates(record: ToolFailureRecord) {
  const values = [
    typeof record.input.path === "string" ? record.input.path : "",
    typeof record.input.command === "string" ? record.input.command : "",
    record.error ?? "",
  ]
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const value of values) {
    for (const match of value.matchAll(/(?:~?\/|\.\.?\/)[^\s"'`]+/g)) {
      const candidate = match[0]
      if (seen.has(candidate)) continue
      seen.add(candidate)
      candidates.push(candidate)
      if (candidates.length >= 3) return candidates
    }
  }
  return candidates
}

function strategy(key: string, instruction: string): RecoveryStrategy {
  return { key, instruction }
}

function getStrategiesForTool(record: ToolFailureRecord): RecoveryStrategy[] {
  const error = (record.error ?? "").toLowerCase()
  const paths = extractPathCandidates(record)

  if (record.tool === "Bash") {
    const strategies: RecoveryStrategy[] = [
      strategy("bash_variant", "Probá un comando equivalente o una variante más acotada del probe anterior."),
      strategy("bash_non_sudo", "Evitá repetir el mismo fallo: intentá una alternativa safe sin sudo, sin TTY y sin mutaciones."),
      strategy("bash_split", "Dividí el diagnóstico en pasos más chicos y verificables en vez de una sola orden grande."),
      strategy("bash_read_fallback", paths[0]
        ? `Si el comando apuntaba a ${paths[0]}, intentá una lectura o inspección directa de esa ruta con otra herramienta o con un comando más simple.`
        : "Si el comando dependía de archivos o logs, intentá una lectura directa o un listado previo antes de repetir el shell."),
    ]
    if (/permission|tty|sudo|denied|permitida/.test(error)) {
      strategies.unshift(strategy("bash_permission_bypass", "El fallo parece de permisos: buscá evidencia equivalente con probes no privilegiados antes de rendirte."))
    }
    return strategies
  }

  if (record.tool === "Read") {
    return [
      strategy("read_verify_path", paths[0]
        ? `Verificá primero si la ruta ${paths[0]} existe o si cambió.`
        : "Verificá la ruta exacta antes de repetir la lectura."),
      strategy("read_parent", paths[0]
        ? `Inspeccioná el directorio padre de ${paths[0]} para descubrir nombres reales o variantes cercanas.`
        : "Inspeccioná el directorio padre o un listado cercano para descubrir el archivo correcto."),
      strategy("read_search_name", "Buscá el archivo por nombre parcial o por contenido relacionado en vez de insistir con la misma ruta."),
      strategy("read_shell_fallback", "Si leer directo falla, intentá una inspección equivalente con una herramienta alternativa y más acotada."),
    ]
  }

  if (/agent/i.test(record.tool)) {
    return [
      strategy("agent_narrower", "Redelegá o reenviá la tarea con un scope más específico y menos contexto."),
      strategy("agent_split", "Dividí la tarea en subtareas más chicas y verificables."),
      strategy("agent_tool_switch", "Cambiá la herramienta o el enfoque del sub-agente; no repitas el mismo camino."),
      strategy("agent_local_fallback", "Si la delegación sigue fallando, continuá localmente usando la evidencia parcial ya obtenida."),
    ]
  }

  return [
    strategy("generic_alt_tool", "Intentá una herramienta o fuente alternativa para llegar al mismo objetivo."),
    strategy("generic_narrow_scope", "Acotá el objetivo inmediato y resolvé primero el subproblema más verificable."),
    strategy("generic_split", "Dividí la tarea en pasos más chicos y evitá repetir exactamente el mismo intento."),
    strategy("generic_partial", "Si no queda una alternativa razonable, sintetizá el progreso útil logrado hasta ahora."),
  ]
}

function pickStrategies(record: ToolFailureRecord, state: RecoveryState) {
  const attempted = new Set(state.attemptedStrategyKeys)
  const available = getStrategiesForTool(record).filter(item => !attempted.has(item.key))
  return available.slice(0, 3)
}

export function createRecoveryState(goal: string, options?: { isSubagent?: boolean }): RecoveryState {
  return {
    goal: clip(goal, 220),
    maxAttempts: options?.isSubagent ? SUBAGENT_MAX_ATTEMPTS : DEFAULT_MAX_ATTEMPTS,
    attempts: 0,
    attemptedStrategyKeys: [],
    exhausted: false,
  }
}

export function planToolFailureRecovery(state: RecoveryState, record: ToolFailureRecord): ToolRecoveryPlan {
  const strategies = pickStrategies(record, state)
  const nextAttempts = state.attempts + 1
  const exhausted = strategies.length === 0 || nextAttempts >= state.maxAttempts
  const attemptedStrategyKeys = [...state.attemptedStrategyKeys, ...strategies.map(item => item.key)]
  const prompt = exhausted
    ? [
        "<tool-recovery>",
        `Objetivo: ${state.goal}`,
        `La herramienta "${record.tool}" falló: ${clip(record.error ?? "unknown error", 400)}`,
        "Ya agotaste las alternativas razonables dentro de este turno.",
        "NO reportes el error crudo al usuario.",
        "Respuesta requerida:",
        "- resumí qué intentaste",
        "- qué evidencia sí obtuviste",
        "- qué quedó bloqueado realmente",
        "- cerrá con una explicación natural y directa",
        "</tool-recovery>",
      ].join("\n")
    : [
        "<tool-recovery>",
        `Objetivo: ${state.goal}`,
        `La herramienta "${record.tool}" falló: ${clip(record.error ?? "unknown error", 400)}`,
        "No te quedes con el error. Probá un camino lateral distinto antes de cerrar.",
        "Alternativas prioritarias:",
        ...strategies.map(item => `- ${item.instruction}`),
        "Reglas:",
        "- no repitas exactamente el mismo intento",
        "- usá evidencia de tools cuando exista",
        "- solo cerrá sin resolver si agotás alternativas razonables",
        "</tool-recovery>",
      ].join("\n")

  return {
    prompt,
    exhausted,
    remainingAttempts: Math.max(0, state.maxAttempts - nextAttempts),
    attemptedStrategyKeys,
  }
}

export function advanceRecoveryState(state: RecoveryState, plan: ToolRecoveryPlan): RecoveryState {
  return {
    ...state,
    attempts: state.attempts + 1,
    attemptedStrategyKeys: plan.attemptedStrategyKeys,
    exhausted: plan.exhausted,
  }
}

export function buildSubagentRetryPrompt(task: string, attempt: number, error: unknown, partialResult?: string) {
  const message = error instanceof Error ? error.message : String(error)
  if (attempt === 1) {
    return [
      task.trim(),
      "",
      "Recovery retry:",
      `- El intento anterior falló con: ${clip(message, 240)}`,
      "- Acotá el alcance y resolvé primero el subproblema más verificable.",
      "- Evitá repetir la misma herramienta o instrucción si ya falló.",
      partialResult ? `- Aprovechá este progreso parcial: ${clip(partialResult, 500)}` : "",
    ].filter(Boolean).join("\n")
  }

  return [
    task.trim(),
    "",
    "Final recovery retry:",
    `- El intento anterior volvió a fallar con: ${clip(message, 240)}`,
    "- Cambiá de enfoque completamente: dividí la tarea o usá otra herramienta/fuente.",
    "- No repitas pasos ya fallidos.",
    "- Si no podés completar todo, devolvé un resultado parcial útil y accionable.",
    partialResult ? `- Progreso parcial disponible: ${clip(partialResult, 500)}` : "",
  ].filter(Boolean).join("\n")
}

export function buildRecommendedUserMessage(taskDescription: string, error: string, partialResult?: string) {
  if (partialResult?.trim()) return clip(partialResult, 1200)
  return clip(`No pude completar ${taskDescription} después de agotar alternativas razonables. El bloqueo real fue: ${error}`, 1200)
}
