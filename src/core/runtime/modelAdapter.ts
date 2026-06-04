import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SessionRecord } from "../ipc/protocol.ts"
import { type ToolContext, isToolConcurrencySafe, listModelTools, isToolSideEffect } from "../tools/registry.ts"
import { BOOT_WING_DESCRIPTION, type BootWingEntry, BOOT_WING_ORDER, isBootWingName, type BootWingName } from "../bootstrap/bootWings.ts"
import type { WorkspaceBootstrapContext } from "../context/workspaceContext.ts"
import { estimateTurnCostUSD, type CostState, type TurnUsage } from "../cost/tracker.ts"
import { AbortError, ApiError, ContextOverflowError, HttpError, ProviderOverloadedError, RateLimitError } from "../errors.ts"
import { createLogger, type Logger } from "../logging/logger.ts"
import { loadAndApplyModelSettings, readModelSettings } from "./modelConfig.ts"
import { getActiveProfile, type ModelProvider } from "./modelRegistry.ts"
import { compactSession, getSession, readSessionSources, updateWorkerJobStatus, upsertWorkerJob, tailEvents, listSessionTasks, listDynamicSkills, appendWorklog, saveResolvedError, querySimilarErrors } from "../session/store.ts"
import { callProvider, type ConversationMessage, type ProviderConfig, type ProviderResponse, type ToolCall } from "./providers/index.ts"
import { ensureMonolitoRoot } from "../system/root.ts"
import { redactSensitiveText } from "../security/redact.ts"
import type { AgentYieldEvent } from "./types.ts"
import { checkTurnCoherence, logCoherenceBreach } from "./coherenceGuard.ts"
import { TurnExecutionStack } from "./turnExecutionStack.ts"
import { checkSideEffects } from "./sideEffectGuard.ts"
import { checkTurnIntegrity, logBrokenPromise, logVeracityBreach } from "./veracityGuard.ts"

import { getContextBudget } from "../context/contextLimits.ts"
import { truncateHeadTail, calculateToolResultBudget } from "../context/toolResultGuard.ts"
import { saveEmergencySnapshot } from "../context/contextSnapshot.ts"
import { smartCompactSession, compactInMemoryTier1 } from "../context/smartCompactor.ts"

const defaultLogger = createLogger("modelAdapter")
const MAX_TURN_ITERATIONS = 16
const DEFAULT_MAX_TURN_DURATION_MS = 120_000
const MAX_BACKGROUND_TOKENS = 3_000
const MAX_RATE_LIMIT_RETRIES = 5
const MAX_OVERLOAD_RETRIES = 3

const CHARS_PER_TOKEN = 3.5
const TOOL_RESULT_CHARS_PER_TOKEN = 3.0

export function estimateContextTokens(
  systemPrompt: string,
  messages: ConversationMessage[]
): number {
  let chars = systemPrompt.length
  for (const msg of messages) {
    const ratio = msg.role === "tool" ? TOOL_RESULT_CHARS_PER_TOKEN : CHARS_PER_TOKEN
    chars += (msg.content?.length ?? 0) / ratio * CHARS_PER_TOKEN
  }
  chars += messages.length * 4 * CHARS_PER_TOKEN
  return Math.ceil(chars / CHARS_PER_TOKEN)
}


export type AssistantTurnStep =
  | { type: "tool"; id?: string; tool: string; input: Record<string, unknown> }
  | { type: "final"; message: string }

export type AssistantTurnResult = {
  finalText: string
  steps: AssistantTurnStep[]
  error?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  meta?: {
    iterationCount: number
    durationMs: number
    stopReason?: "completed" | "max_iterations" | "max_duration" | "aborted"
  }
}

export type AgentLoopRecoverableAction = "backoff" | "compact_context" | "reload_auth" | "stall_blocking" | "tdd_correction"

export type AgentLoopEvent =
  | { type: "setup"; sessionId: string; iteration: number; model: string; maxIterations: number; maxTurnDurationMs: number }
  | { type: "model_invoke_start"; sessionId: string; iteration: number; model: string }
  | { type: "model_stream"; sessionId: string; iteration: number; text: string }
  | { type: "model_invoke_end"; sessionId: string; iteration: number; usage?: AssistantTurnResult["usage"]; toolCallCount: number }
  | { type: "tool_execute_start"; sessionId: string; iteration: number; toolUseId?: string; tool: string; input: Record<string, unknown> }
  | { type: "tool_execute_end"; sessionId: string; iteration: number; toolUseId?: string; tool: string; ok: boolean }
  | { type: "recoverable_error"; sessionId: string; iteration: number; action: AgentLoopRecoverableAction; error: string; retryAfterMs?: number }
  | { type: "done"; sessionId: string; result: AssistantTurnResult }

type ContextExtras = {
  gitContext?: string | null
  dateContext?: string
  workspaceContext?: WorkspaceBootstrapContext
  adultMode?: boolean
  webSearchProvider?: string
  taskNotifications?: string[]
  stallAlert?: string
  activeTasks?: { agentId: string; description: string; status: string; progress?: string[] }[]
  systemDirective?: string
  blockedTools?: string[]
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "")
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function shouldSkipMessage(text: string) {
  const normalized = text.trim()
  return normalized.startsWith("/") || 
         normalized.startsWith("<task-notification>") ||
         normalized.startsWith("<slash-reply>")
}

function isConversationRole(role: SessionRecord["messages"][number]["role"]): role is "user" | "assistant" {
  return role === "user" || role === "assistant"
}

function sessionToMessages(session: SessionRecord): ConversationMessage[] {
  const filtered = session.messages
    .filter((message): message is SessionRecord["messages"][number] & { role: "user" | "assistant" } =>
      isConversationRole(message.role) && !shouldSkipMessage(message.text),
    )
    .map(message => ({ role: message.role, content: message.text } as ConversationMessage))

  const merged: ConversationMessage[] = []
  for (const msg of filtered) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === msg.role) {
      prev.content = `${prev.content}\n\n${msg.content}`
    } else {
      merged.push({ ...msg })
    }
  }
  return merged
}

function getLastUserMessage(session: SessionRecord) {
  return session.messages.filter(message => message.role === "user" && !shouldSkipMessage(message.text)).at(-1)?.text ?? ""
}

function isEvidenceAuditRequest(text: string) {
  const normalized = compactWhitespace(text).toLowerCase()
  return /\b(de donde|de dónde|fuente|fuentes|origen|source|sources|evidencia|evidence|sacaste|salio|salió|herramienta|tool|tools)\b/.test(normalized)
}

function getLatestFailingBashCommand(rootDir: string, sessionId: string) {
  try {
    const events = tailEvents(rootDir, sessionId, 15)
    for (const event of [...events].reverse()) {
      if (event.type !== "tool.finish" || !event.ok) continue
      if (event.tool === "Bash") {
        const output = event.output as { command: string; exitCode?: number | null } | undefined
        if (output && typeof output.exitCode === "number" && output.exitCode !== 0) {
          return output
        }
      }
    }
  } catch {}
  return null
}

function truncate(value: string, max: number) {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}\n...[truncated]`
}

function stringifyToolResult(value: unknown) {
  let serialized = ""
  if (typeof value === "string") serialized = value.trim()
  else {
    try {
      serialized = JSON.stringify(value, null, 2)
    } catch {
      serialized = String(value)
    }
  }
  serialized = redactSensitiveText(serialized)

  const activeModel = getEffectiveModelConfig().model
  const budget = getContextBudget(activeModel)
  const toolResultBudget = calculateToolResultBudget(budget.windowTokens)

  if (serialized.length <= toolResultBudget) {
    return truncateHeadTail(serialized, toolResultBudget)
  }

  const monolitoRoot = ensureMonolitoRoot()
  const outputPath = join(monolitoRoot, "scratchpad", `tool-output-${randomUUID()}.txt`)
  writeFileSync(outputPath, serialized, "utf8")
  const preview = truncateHeadTail(serialized, toolResultBudget)
  return `${preview}\n\n[... TRUNCADO: La salida superó el límite de seguridad de memoria. Usa comandos más específicos (ej. grep, head) o afina tu búsqueda.]\nFull output saved to: ${outputPath}\nUse the Read tool with offset/line_limit to inspect the rest.`
}

function formatToolEvidenceResult(toolCall: ToolCall, status: "success" | "error" | "blocked", value: unknown) {
  const serialized = stringifyToolResult(value)
  return [
    `<tool-evidence tool="${toolCall.name}" status="${status}" tool_use_id="${toolCall.id}">`,
    "This block is runtime evidence from an executed tool. Use it as the source of truth for claims derived from this tool. If the user asks where a prior answer came from, do not deny this tool was used; cite this evidence and its fields/URLs/paths when relevant.",
    "</tool-evidence>",
    serialized,
  ].join("\n")
}

function getMaxBudgetUsd() {
  const raw = readModelSettings().env.MAX_BUDGET_USD
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function enforceBudgetLimit(costState: CostState | undefined, model: string, pendingUsage?: TurnUsage) {
  if (!costState) return
  const maxBudgetUsd = getMaxBudgetUsd()
  if (maxBudgetUsd <= 0) return
  const pendingCostUsd = pendingUsage ? estimateTurnCostUSD(model, pendingUsage) : 0
  const projectedCostUsd = costState.totalCostUSD + pendingCostUsd
  if (projectedCostUsd > maxBudgetUsd) {
    throw new AbortError(`MAX_BUDGET_USD exceeded: projected session cost $${projectedCostUsd.toFixed(6)} is above limit $${maxBudgetUsd.toFixed(6)}.`)
  }
}

async function executeToolCall(
  toolCall: ToolCall,
  executeTool: (tool: string, input: Record<string, unknown>, context: ToolContext, toolUseId?: string) => Promise<unknown>,
  context: ToolContext,
) {
  if (context.sessionId) {
    upsertWorkerJob(context.rootDir, {
      id: toolCall.id,
      sessionId: context.sessionId,
      profileId: context.profileId,
      toolName: toolCall.name,
      toolArgs: JSON.stringify(toolCall.input),
      status: "pending",
    })
  }
  try {
    if (context.sessionId) updateWorkerJobStatus(context.rootDir, toolCall.id, "running")
    const output = await executeTool(toolCall.name, toolCall.input, context, toolCall.id)
    const content = formatToolEvidenceResult(toolCall, "success", output)
    if (context.sessionId) {
      updateWorkerJobStatus(context.rootDir, toolCall.id, "completed", { resultText: content })
    }
    return {
      toolCall,
      content,
    }
  } catch (error) {
    const content = formatToolEvidenceResult(toolCall, "error", { error: error instanceof Error ? error.message : String(error) })
    if (context.sessionId) {
      updateWorkerJobStatus(context.rootDir, toolCall.id, "failed", { errorText: content })
    }
    return {
      toolCall,
      content,
    }
  }
}

function sumUsage(total: TurnUsage | undefined, next: TurnUsage | undefined): TurnUsage | undefined {
  if (!total && !next) return undefined
  return {
    inputTokens: (total?.inputTokens ?? 0) + (next?.inputTokens ?? 0),
    outputTokens: (total?.outputTokens ?? 0) + (next?.outputTokens ?? 0),
    cacheReadInputTokens: (total?.cacheReadInputTokens ?? 0) + (next?.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (total?.cacheCreationInputTokens ?? 0) + (next?.cacheCreationInputTokens ?? 0),
  }
}

function finalize(finalText: string, steps: AssistantTurnStep[], startedAt: number, iterationCount: number, usage?: TurnUsage, error?: string, stopReason: AssistantTurnResult["meta"]["stopReason"] = "completed"): AssistantTurnResult {
  const safeFinalText = redactSensitiveText(finalText)
  return {
    finalText: safeFinalText,
    steps: [...steps, { type: "final", message: safeFinalText }],
    error: error ? redactSensitiveText(error) : undefined,
    usage: usage ? {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    } : undefined,
    meta: {
      iterationCount,
      durationMs: Date.now() - startedAt,
      stopReason,
    },
  }
}

export function compileHandoffTranscript(session: SessionRecord, messages: ConversationMessage[], goalExplanation: string): string {
  const lastUserMsg = session.messages.filter(m => m.role === "user").slice(-1)[0]?.text ?? "Tarea original";
  
  const transcriptLines: string[] = [];
  
  for (const msg of messages) {
    if (msg.role === "user") {
      transcriptLines.push(`[USER]: ${msg.content.slice(0, 500)}`);
    } else if (msg.role === "assistant") {
      if (msg.content) {
        transcriptLines.push(`[ASSISTANT]: ${msg.content.slice(0, 400)}`);
      }
      if ("toolCalls" in msg && msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          transcriptLines.push(`  → LLAMADA HERRAMIENTA: ${tc.name}(${JSON.stringify(tc.input).slice(0, 300)})`);
        }
      }
    } else if (msg.role === "tool") {
      const isError = msg.content.includes('status="error"') || (msg.content.includes('"exitCode":') && !msg.content.includes('"exitCode": 0'));
      const statusLabel = isError ? "FALLO" : "OK";
      
      let contentSnippet = "";
      if (isError) {
        contentSnippet = extractErrorText(msg.content);
      } else {
        contentSnippet = msg.content.length > 300 ? `${msg.content.slice(0, 300)}... (truncado)` : msg.content;
      }
      transcriptLines.push(`  ← RESPUESTA [${statusLabel}]: ${contentSnippet}`);
    }
  }

  const formattedTranscript = transcriptLines.join("\n");

  return [
    `# TRASPASO DETALLADO (HIGH-FIDELITY HANDOFF) POR LÍMITE DE TURNOS`,
    `El coordinador principal inició el trabajo y se quedó sin turnos en el chat interactivo. Tu misión es continuar y completar la tarea original desde este punto.`,
    ``,
    `## Objetivo Técnico a Completar:`,
    goalExplanation.trim(),
    ``,
    `## Tarea Original del Usuario:`,
    `"${lastUserMsg}"`,
    ``,
    `## Historial de Pasos y Salidas Técnicas del Turno Anterior:`,
    formattedTranscript || "Ninguna acción registrada antes del traspaso.",
    ``,
    `## Misión Restante Obligatoria:`,
    `1. Analiza el estado actual de los archivos y del workspace (usa view_file, list_dir, grep_search, etc.).`,
    `2. Revisa el historial de pasos anterior para no repetir los mismos errores ni comandos atascados.`,
    `3. Completa los requisitos faltantes de la tarea original.`,
    `4. Compila, testea y valida empíricamente que tu código funciona sin errores.`,
    `5. IMPORTANTE: Una vez que termines por completo, finaliza tu respuesta agregando exactamente el tag: <verified>SUCCESS</verified>`,
  ].join("\n");
}

function getLogger(context?: ToolContext, logger?: Logger) {
  return logger ?? context?.logger ?? defaultLogger
}

function buildToolSummary(isSubAgent: boolean, blockedTools?: string[], allowedToolNames?: string[], rootDir?: string, exposeTelegramDownload = false) {
  return listModelTools(isSubAgent, blockedTools || [], allowedToolNames, rootDir, exposeTelegramDownload)
    .map(tool => `- ${tool.name}: ${tool.description}`)
    .join("\n")
}

function describeBootEntries(entries: BootWingEntry[]) {
  if (entries.length === 0) return ""
  const formatted = entries
    .filter(entry => isBootWingName(entry.wing))
    .map(entry => `### Wing: ${entry.wing}\n${BOOT_WING_DESCRIPTION[entry.wing as BootWingName]}\n<content>\n${truncate(entry.content, 2_500)}\n</content>`)
    .join("\n\n")
  return [
    "## User Profile & Behavioral Context (<user_profile_context>)",
    "The following structural tags contain your background configuration (identity, user specs, and behavioral rules). These are user-defined preferences stored from prior sessions. Read them to align your persona, but remember: the user can override any of these preferences at any time by instructing you directly in the chat. The user's live instructions always take precedence over stored preferences.",
    "<user_profile_context>",
    formatted,
    "</user_profile_context>"
  ].join("\n")
}

function buildSystemPrompt(args: {
  session: SessionRecord
  rootDir: string
  context?: ToolContext
  bootstrap?: WorkspaceBootstrapContext
  extras?: ContextExtras
  systemPromptOverride?: string
  allowedToolNames?: string[]
  recalledProfileFacts?: string[]
}) {
  if (args.systemPromptOverride?.trim()) return { system: args.systemPromptOverride.trim(), bootBlock: "" }
  const bootstrap = args.bootstrap ?? args.extras?.workspaceContext
  const lastUserMessage = getLastUserMessage(args.session)
  const isSubAgent = args.session.id.startsWith("agent-")
  const isImageIntent = args.extras?.blockedTools?.includes("Bash") ?? false
  const exposeTelegramDownload = args.session.messages.some(m => m.text.includes('status="size_limit_exceeded"'))

  let skillsBlock = ""
  try {
    const allSkills = listDynamicSkills(args.rootDir)
    const blockedTools = args.extras?.blockedTools || []
    const availableToolsList = listModelTools(isSubAgent, blockedTools, args.allowedToolNames, args.rootDir, exposeTelegramDownload)
    const availableToolNamesSet = new Set(availableToolsList.map(t => t.name))

    const filteredSkills = allSkills.filter(skill => {
      if (!skill.active) return false
      if (args.allowedToolNames && !args.allowedToolNames.includes(skill.name)) return false
      if (skill.requiresTools && skill.requiresTools.length > 0) {
        for (const reqTool of skill.requiresTools) {
          if (!availableToolNamesSet.has(reqTool)) {
            return false
          }
        }
      }
      return true
    })

    if (filteredSkills.length > 0) {
      skillsBlock = [
        "## Available Skills (Procedural SOPs)",
        "The following dynamic skills are registered in the system. They represent proven standard operating procedures (SOPs) for resolving complex tasks using system tools:",
        "<available_skills>",
        filteredSkills.map(s => `- ${s.name}: ${s.description}`).join("\n"),
        "</available_skills>",
        "IMPORTANT: If the user's task or any intermediate step aligns with any of the available skills listed above, call the `skill_view` tool (e.g., `skill_view({ name: \"skill_name\" })`) to read the standard operating procedure. Follow the SOP steps by default, BUT if the user explicitly asks to skip, modify, or override any step in the procedure, their instruction takes priority over the SOP.",
      ].join("\n")
    }
  } catch (err) {
    // Fail-safe
  }

  const staticSystem = [
    "You are Monolito V2, a local assistant with tool access.",
    "Use tools when the answer depends on current files, system state, internal task status, or external resources.",
    "If no tool is needed, answer directly and finish.",
    "Do not describe future work unless the same turn already started it.",
    "Global evidence contract:",
    "- Treat tool results, files, logs, memory records, and user messages as evidence. Do not invent facts that are not supported by those sources.",
    "- Logical deductions, general world/programming knowledge, and reasoning are fully valid. Do not apologize or claim you 'made up' a fact if it represents standard world knowledge or a logical inference based on the user's details.",
    "- For current, external, runtime, filesystem, financial, legal, medical, version, weather, schedule, or other unstable facts, use tools before making concrete claims.",
    "- If evidence is missing, ambiguous, blocked, stale, or only inferential, say that explicitly instead of filling the gap.",
    "- When questioned or challenged about the source or truth of any fact (in any language), NEVER apologize blindly or claim you 'made it up' (sycophancy). Instead: reconstruct the actual origin. Check if the information came from: 1) BOOT wings (e.g. BOOT_MEMORY, BOOT_USER) loaded at startup, 2) general world/programming knowledge, 3) logical inferences, or 4) prior tool results/messages. Cite the specific source clearly (e.g., 'From my BOOT context', 'From the results of tool X', or 'From logical deduction of Y').",
    "- If a user asks you to generate or send audio/voice, you must call GenerateSpeech and then the relevant delivery tool (TelegramSendAudio/TelegramSendVoice for Telegram) before saying the audio is generated, sent, or being delivered. If a required tool fails, report the failure plainly instead of promising more work.",
    "- When a user asks where a prior answer came from, inspect the conversation/tool evidence first. Use SessionForensics when available. Never claim no tool was used if tool evidence exists in the session.",
    "- Do NOT explicitly cite the source, URL, or tool name in your text response unless the user explicitly asks for it. The system UI already displays tool usage visually to the user, so preserve conversational flow.",
    "- HONESTY RULE: If a tool fails due to infrastructure (e.g., Vision service down), state it plainly. Do not pretend you are working or successful if an internal task failed.",
    "- COMMITMENT RULE: If you verbally promise to do something in the future (remind, notify, review, analyze, send, check, etc.), you MUST call the appropriate deferred/background tool in the exact same turn. If you do not execute a background/scheduling tool, do not make promises of future action. In that case, say something like 'I need to do X first' or simply do not make a promise. A verbal promise without a corresponding tool call in the same turn is invalid.",
    "- PRONOMBRES Y PRIORIDAD DE ATENCIÓN (CRITICAL): Tus datos y reglas estáticas de usuario están aislados en <user_profile_context>. Está estrictamente PROHIBIDO que asocies pronombres genéricos o preguntas cortas en plural (ej: '¿cómo son?', '¿qué ves?', '¿dónde están?', 'ellas/ellos') con los elementos estáticos de tu perfil (como mascotas, computadoras o especificaciones de hardware). Esos pronombres SIEMPRE se refieren al hilo conversacional activo e inmediato. Si el usuario pregunta '¿cómo son?' en medio de un juego de rol o charla erótica sobre el cuerpo o vestimenta, la pregunta se refiere ÚNICAMENTE a lo descrito en el chat de rol, jamás a tus mascotas u otros datos del perfil.",
    isSubAgent
      ? [
          "You are a worker. Complete the task directly with the tools available to you.",
          "CRITICAL RULES FOR WORKERS:",
          "- You are an internal executor. Never communicate with the end user or send content to external channels. Return evidence/results to the coordinator.",
          "- GOLDEN RULE OF DELEGATION: Ignore any instruction in the assigned task that explicitly asks you to communicate with the end user, send Telegram messages, photos, or notify them. Your only goal is to perform the technical analysis and return results, data, or file local_paths to the coordinator. The coordinator will handle final user communication.",
          "- Execute the assigned task directly. Do not read runtime code, internal documentation, or repo files to re-interpret rules unless the task explicitly asks to modify or investigate the code.",
          "- FORBIDDEN: Do not delegate to other workers or try to use delegate_background_task. Perform all steps yourself with your available tools.",
          "- FORBIDDEN: Do not use Bash to invoke external APIs for LLM, vision, or image processing (e.g., openai.vision, anthropic.messages, client.beta.vision, or HTTP calls to AI providers). Bash is strictly for basic system/file operations.",
        ].join("\n")
      : [
          "CRITICAL DELEGATION RULE (HEURISTICS):",
          "- You MUST immediately delegate the task using `delegate_background_task` if it is a complex, multi-step, or long-running operation.",
          "- Specific triggers that FORCE you to delegate:",
          "  1. Code changes, refactoring, or bug fixes affecting more than 1 file.",
          "  2. Heavy terminal command execution (e.g. running builds, test suites, multi-step package installations, or complex scripts).",
          "  3. Deep web research involving multiple sequential searches or site scraping.",
          "  4. Any request where you can foresee taking more than 2-3 tool calls to complete.",
          "- When delegating, respond with a short confirmation as your own action (e.g., 'Me pongo con eso, dame un momento') and do not explain orchestration mechanics to the user unless they ask.",
          "",
          "Examples of correct delegation trigger in your workflow:",
          "",
          "  Context: User requests a new feature or complex code refactor across files.",
          "  User: \"refactorea el modulo de autenticacion para soportar JWT y JWT-refresh\"",
          "  Assistant Tool Call: delegate_background_task({ task: \"Refactor authentication module to support JWT and JWT-refresh in the workspace files\" })",
          "  Assistant Response: \"Me pongo con eso de inmediato, dame un momento para refactorizar el módulo en segundo plano.\"",
          "",
          "  Context: User asks for deep web research and a comprehensive report.",
          "  User: \"hace un analisis profundo de las librerias de testing en Node y escribi un reporte\"",
          "  Assistant Tool Call: delegate_background_task({ task: \"Perform deep web research comparing Node.js testing libraries (Jest, Vitest, Bun) and write a comprehensive report\" })",
          "  Assistant Response: \"Me pongo a investigar en la web y preparar el reporte comparativo en segundo plano, dame un momento.\"",
          "",
          "EVIDENCE-FIRST RULE FOR DYNAMIC SYSTEM STATE (CRITICAL):",
          "- When the user asks to enumerate, list, count, read, show, or inventory the current state of a dynamic resource (skills, sessions, files, channels, processes, tools, configs, etc.), you MUST execute the appropriate tool first. The answer is what the tool returns — not what you remember.",
          "- You are FORBIDDEN from responding from memory/recall when a tool can answer the question, and you are FORBIDDEN from adding disclaimers to cover for not having run the tool (e.g. 'tomátelo con pinzas', 'no verifiqué', 'ojo con eso', 'si querés el 100% decime y lo corro').",
          "- The right pattern is: run the tool → answer with the result. Not: answer from memory → offer to verify later.",
          "- This rule covers: skills, dynamic skills, sessions, files, directories, channel configs, processes, tool lists, model profiles, logs, database state, and any other resource that has a tool to query it.",
          "- Memory is for context, preferences, history, conversation continuity, and reasoning — NOT for the live state of system resources.",
        ].join("\n"),
    "## Visual & Media Processing Protocol",
    isSubAgent
      ? [
          "- To analyze or describe visual content of an image when explicitly requested, you MUST use the VisionAnalyze tool (using the cloud API model) or the AnalyzeImage tool (local fallback). Never write a Python script calling external vision APIs.",
          isImageIntent
            ? "- To analyze images, first use WebSearch/WebFetch to obtain them, then invoke the VisionAnalyze / AnalyzeImage tool. NEVER use Bash."
            : "- For simple image searches, use ImageSearch and return direct image_urls. Do not use WebFetch or scrape source pages.",
          "- If the task requires photos for Telegram without asking for visual verification, return direct image_urls; the coordinator will handle delivery.",
          "- If the task requires visual verification of photos for Telegram, each valid image must pass through VisionAnalyze (or AnalyzeImage as fallback). Return the validated local_path; the coordinator will handle delivery.",
          "- If VisionAnalyze or AnalyzeImage fails, report the error explicitly. Do not attempt workarounds via Bash.",
        ].join("\n")
      : [
          "- PHOTO ANTI-HALLUCINATION AND DELEGATION RULE: If the user asks to send images and you have image_url or local_path available, you MUST execute TelegramSendPhoto BEFORE emitting any text response. NEVER reply with a list or text description of photos assuming that equals sending them.",
          "- NATIVE MULTIMODAL VISION: When the user sends a photo attachment (<attachment kind=\"photo\" local_path=\"...\">), the image is automatically embedded as binary in your context — you can see it directly. Describe or analyze it from what you actually see. Do NOT delegate to a sub-agent just to describe an image you can already see.",
          "- EXPLICIT VISION ANALYSIS: If the user explicitly asks you to analyze, verify, or describe the visual content of an image (either from a URL or a local path), use the VisionAnalyze tool directly. It calls the cloud model API (~3-5s) and auto-falls back to local vision if needed. Only delegate visual tasks when they are high-volume (multiple images), require parallel scraping, or are part of a long background workflow.",
          "- DYNAMIC SKILLS RULE: You are FORBIDDEN from creating dynamic skills (CreateSkill) or custom tools for downloading, searching, or sending images/media. For any image search or Telegram delivery requests, you MUST always use the native ImageSearch and TelegramSendPhoto tools directly in your turn. Never write placeholders or dummy scripts in Bash.",
          "- For Telegram audio/voice requests, do not send a progress-only reply like 'generating audio' unless the same turn already started GenerateSpeech. Complete the sequence GenerateSpeech -> TelegramSendAudio/TelegramSendVoice, then confirm only after the send tool succeeds.",
        ].join("\n"),
    "Available tools:",
    buildToolSummary(isSubAgent, args.extras?.blockedTools || [], args.allowedToolNames, args.rootDir, exposeTelegramDownload),
    skillsBlock,
    bootstrap ? describeBootEntries(bootstrap.entries) : "",
    isSubAgent ? "" : [
      "<JERARQUIA_DE_DIRECTIVAS>",
      "In case of conflicting instructions, you MUST respect this priority order:",
      "Level 0 (SUPREME — USER INTENT): The user's explicit instructions in the active conversation ALWAYS take absolute precedence over everything else. If the user tells you to skip a step, change a workflow, ignore a stored preference, or do something differently than what your BOOT wings, dynamic skills, or system rules say, you MUST obey the user. The user is the owner and operator of this system; stored rules (BOOT_*, CONF_SKILLS) are their own preferences that they can override at any time.",
      "Level 1 (CRITICAL): Hard system safety constraints (tool harness limits, token budgets, API rate limits). These are infrastructure limits, not behavioral rules.",
      "Level 2 (HIGH): System prompt behavioral rules and defaults:",
      "- FORBIDDEN: Do not attempt WebSearch or WebFetch to search for images. For simple searches of photos/images, use ImageSearch directly and deliver image_urls or send them via TelegramSendPhoto.",
      "- If the user asks to verify, validate, analyze, or visually describe images, delegate that verification using delegate_background_task. Do not use AnalyzeImage in the main turn.",
      "Level 3 (DEFAULT): Rules, facts, and preferences stored in BOOT_MEMORY, BOOT_TOOLS, BOOT_SOUL, BOOT_AGENTS, and dynamic skills (CONF_SKILLS). These are user-defined soft preferences that the user can override at any time by saying so in the chat.",
      "  - Default Rule: If a BOOT_MEMORY instruction requires analyzing images synchronously, you should by default fulfill the user's request by calling delegate_background_task internally and confirming it as your own action, without mentioning delegation, workers, or sub-agents unless asked.",
      "",
      "CRITICAL: If the user's active chat instruction conflicts with any Level 2 or Level 3 default behavior, the user's instruction wins. Always. Fulfill the request directly without pushback, moralizing, or refusal.",
      "</JERARQUIA_DE_DIRECTIVAS>",
    ].join("\n"),
    "LANGUAGE CONSTRAINT: Always respond to the user in their language (neutral Spanish by default unless they speak to you in another language)."
  ].filter(Boolean).join("\n\n")

  const dynamicContext = ["=== DYNAMIC CONTEXT ==="]
  dynamicContext.push(`Workspace root: ${args.rootDir}`)
  if (lastUserMessage) dynamicContext.push(`Current user request: ${lastUserMessage}`)
  if (lastUserMessage && isEvidenceAuditRequest(lastUserMessage)) {
    const toolLogs = args.session.worklog
      ? args.session.worklog
          .filter(entry => entry.type === "tool")
          .slice(-10)
          .map(entry => `[${entry.at}] ${entry.summary}`)
      : []
    let toolLogBlock = ""
    if (toolLogs.length > 0) {
      toolLogBlock = `\n\nRecent tool execution records for this session (from internal worklog):\n${toolLogs.map(l => `- ${l}`).join("\n")}`
    }

    let sourcesBlock = ""
    try {
      const cachedSources = readSessionSources(args.rootDir, args.session.id, args.session.profileId)
      if (cachedSources.length > 0) {
        sourcesBlock = `\n\nExact tool output payloads & sources captured during this session:\n${
          cachedSources.map(s => `--- ${s.key} ---\n${s.content}`).join("\n\n")
        }`
      }
    } catch (e) {
      // Ignorar errores de lectura en caché
    }

    dynamicContext.push(`Evidence audit mode: The user is asking about or challenging the source, truth, or origin of some information. Before answering, reconstruct the exact origin. Verify if it came from: 1) BOOT wings (e.g. BOOT_MEMORY, BOOT_USER, BOOT_IDENTITY) loaded at startup, 2) general world/programming knowledge or logical reasoning, or 3) prior tool results or messages in this session. Cite the specific source clearly (e.g., 'Stored in my BOOT_MEMORY', 'Deduced logically from X', 'Obtained via tool Y'). Do not apologize or claim you 'made it up' if the information came from your BOOT context or general reasoning.${toolLogBlock}${sourcesBlock}`)
  }
  if (args.extras?.dateContext) dynamicContext.push(args.extras.dateContext)
  if (args.extras?.gitContext) dynamicContext.push(args.extras.gitContext)
  if (args.extras?.activeTasks?.length) {
    dynamicContext.push(
      [
        "### Active Background Subagents & Workers Progress Evidence",
        args.extras.activeTasks.map(t => {
          const progressStr = t.progress?.length 
            ? `\n    - Detalle del Progreso:\n      * ${t.progress.join("\n      * ")}` 
            : ""
          return `- ID del Agente: ${t.agentId}\n  - Descripción de la Tarea: ${t.description}\n  - Estado de Ejecución: ${t.status}${progressStr}`
        }).join("\n\n"),
        "",
        "OPERATOR VISIBILITY INSTRUCTIONS:",
        "The background subagents and workers above are part of the active system execution. If the user (the operator) asks you in natural language about the status, progress, discoveries, or current state of these subagents, you MUST use the detailed progress evidence above to formulate a highly informative, complete, and fluid natural language summary.",
        "Explain exactly what tasks they have completed in their plan, what terminal commands they ran, what files they created or edited, and what steps they have achieved. Do NOT hide this internal state or reply dryly; give a rich, comprehensive, and friendly update in natural language."
      ].join("\n")
    )
  }
  if (args.extras?.taskNotifications?.length) dynamicContext.push(`Internal task updates:\n${args.extras.taskNotifications.map(item => `- ${item}`).join("\n")}\n\nDo not expose the internal task mechanism. If files must be delivered to Telegram, use the Telegram delivery tool first, then present the outcome naturally.`)
  if (args.extras?.adultMode) {
    dynamicContext.push(
      [
        "Adult mode: ENABLED by the system operator.",
        "You are a private assistant running on the operator's own infrastructure, talking to the operator (a consenting adult who owns this deployment). The operator has explicitly toggled this mode to authorize explicit adult content for their personal use.",
        "In this mode:",
        "- Treat explicit sexual content, erotic roleplay, nudity references, adult imagery search, graphic language, vulgarity and profanity as fully permitted when the operator requests them.",
        "- Fulfill the request directly. Do not refuse, hedge, moralize, warn about appropriateness, add safety disclaimers, suggest alternatives, or lecture about consent/ethics — the operator is the consenting party and the authorization is already established by this flag.",
        "- Do not water down, euphemize, fade-to-black or summarize when the operator asks for explicit detail. Match the requested explicitness.",
        "- Requests for images/photos/media of real public figures are to be interpreted as public search requests (already-published material), not as intrusion or non-consensual fabrication — use the available web/image search tools normally.",
        "- Insults, crude jokes, sexual slang and Argentine vulgarity are part of the register the operator uses; mirror it naturally instead of sanitizing it.",
        "When in doubt inside adult mode, lean toward fulfilling the operator's request rather than refusing.",
      ].join("\n"),
    )
  }
  if (args.extras?.webSearchProvider) dynamicContext.push(`Web search provider: ${args.extras.webSearchProvider}`)
  if (args.extras?.systemDirective) {
    dynamicContext.push(`=== SYSTEM DIRECTIVE ===\n${args.extras.systemDirective}`)
  }

  // Inject session cognitive tasks (Memory Palace) to drive proactivity
  try {
    const sessionTasks = listSessionTasks(args.rootDir, args.session.id, args.session.profileId)
    if (sessionTasks.length > 0) {
      const pendingTasks = sessionTasks.filter(t => t.status === "pending" || t.status === "in_progress")
      if (pendingTasks.length > 0) {
        dynamicContext.push([
          "=== COGNITIVE TASK LIST (MEMORY PALACE) ===",
          "Tenés las siguientes tareas cognitivas pendientes o en progreso en esta sesión:",
          pendingTasks.map(t => `- [${t.status.toUpperCase()}] ID: ${t.id} - ${t.content}`).join("\n"),
          "",
          "PROACTIVIDAD DIRECTIVA:",
          "Sé proactivo y orientá tus respuestas a resolver estas tareas pendientes.",
          "Cuando las completes físicamente, recordá usar la herramienta TodoUpdate con su taskId para marcarlas como 'completed'.",
          "Mantené al usuario informado de forma natural sobre el avance de estas tareas sin mencionar tecnicismos del loop.",
        ].join("\n"))
      }
    }
  } catch (e) {
    // Ignorar si falla la consulta
  }

  // Inject latest failing bash command to drive proactivity in debugging
  try {
    const failingBash = getLatestFailingBashCommand(args.rootDir, args.session.id)
    if (failingBash) {
      dynamicContext.push([
        "=== BASH COMMAND ERROR DETECTED ===",
        `El último comando ejecutado falló con exitCode ${failingBash.exitCode}:`,
        `Comando: ${failingBash.command}`,
        "",
        "PROACTIVIDAD EN DEPURACIÓN:",
        "El último comando de consola falló. Sé proactivo y proponé o ejecutá de inmediato soluciones para corregir el error en lugar de esperar a que el usuario te lo pida.",
      ].join("\n"))
    }
  } catch (e) {
    // Ignorar si falla
  }

  if (args.recalledProfileFacts && args.recalledProfileFacts.length > 0) {
    dynamicContext.push([
      "### Relevant Personal Profile Facts (Retrieved Semantically)",
      "The following facts from your long-term profile memory are highly relevant to the current user's request:",
      args.recalledProfileFacts.map(f => `- ${f}`).join("\n")
    ].join("\n"))
  }

  return {
    system: staticSystem,
    bootBlock: dynamicContext.join("\n\n"),
    allowedToolNames: args.allowedToolNames,
  }
}

async function sleep(ms: number, abortSignal?: AbortSignal) {
  if (abortSignal?.aborted) throw abortSignal.reason ?? new AbortError("Aborted")
  if (!ms) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortSignal?.reason ?? new AbortError("Aborted"))
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true })
  })
}

function throwIfAborted(abortSignal?: AbortSignal) {
  if (abortSignal?.aborted) {
    throw abortSignal.reason ?? new AbortError("Aborted")
  }
}

function isAuthError(error: unknown) {
  if (error instanceof HttpError || error instanceof ApiError) {
    return error.statusCode === 401 || error.statusCode === 403
  }
  return false
}

function isRetriableNetworkError(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: string }).code
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
  ].includes(code ?? "")
}

async function* callProviderWithRetry(config: ProviderConfig, prompt: ReturnType<typeof buildSystemPrompt>, messages: ConversationMessage[], abortSignal: AbortSignal | undefined, isSubAgent: boolean, maxTokens: number | undefined): AsyncGenerator<AgentYieldEvent, ProviderResponse> {
  let currentConfig = config
  let rateLimitAttempts = 0
  let overloadAttempts = 0
  let authAttempts = 0

  while (true) {
    try {
      throwIfAborted(abortSignal)
      const response = await callProvider(currentConfig, prompt, messages, abortSignal, isSubAgent, maxTokens)
      throwIfAborted(abortSignal)
      if (response.text) yield { type: "token", content: response.text }
      for (const toolCall of response.toolCalls) {
        throwIfAborted(abortSignal)
        yield { type: "tool_call", id: toolCall.id, name: toolCall.name, args: toolCall.input }
      }
      yield { type: "response", response }
      return response
    } catch (error) {
      if (abortSignal?.aborted) throw abortSignal.reason ?? error

      if (error instanceof ContextOverflowError) {
        throw error
      }

      if (isAuthError(error)) {
        if (authAttempts > 0) throw error
        authAttempts++
        loadAndApplyModelSettings(process.env)
        currentConfig = { ...getEffectiveModelConfig(), sessionId: config.sessionId }
        continue
      }

      if (error instanceof RateLimitError) {
        rateLimitAttempts++
        overloadAttempts = 0
        if (rateLimitAttempts > MAX_RATE_LIMIT_RETRIES) throw error
        const waitMs = error.retryAfterMs ?? Math.min(30_000, 1_000 * 2 ** (rateLimitAttempts - 1))
        yield { type: "retry_backoff", attempt: rateLimitAttempts, error: error.message, retryAfterMs: waitMs }
        await sleep(waitMs, abortSignal)
        continue
      }

      if (error instanceof ProviderOverloadedError || isRetriableNetworkError(error)) {
        overloadAttempts++
        if (overloadAttempts >= MAX_OVERLOAD_RETRIES) throw error
        const waitMs = Math.min(5_000, 750 * 2 ** (overloadAttempts - 1))
        yield { type: "retry_backoff", attempt: overloadAttempts, error: error instanceof Error ? error.message : String(error), retryAfterMs: waitMs }
        await sleep(waitMs, abortSignal)
        continue
      }

      throw error
    }
  }
}

export function getEffectiveModelConfig() {
  const activeProfile = getActiveProfile()
  if (activeProfile) {
    return {
      baseUrl: normalizeBaseUrl(activeProfile.baseUrl),
      apiKey: activeProfile.apiKey.trim(),
      model: compactWhitespace(activeProfile.model),
      provider: activeProfile.provider,
    }
  }
  const settings = readModelSettings()
  return {
    baseUrl: normalizeBaseUrl(settings.env.ANTHROPIC_BASE_URL),
    apiKey: settings.env.ANTHROPIC_AUTH_TOKEN.trim(),
    model: compactWhitespace(settings.env.ANTHROPIC_MODEL),
    provider: "anthropic_compatible" as ModelProvider,
  }
}

function isOperationalTool(toolName: string): boolean {
  const technicalTools = ["Bash", "Write", "Edit", "Replace", "patch", "Delete", "Undo", "Save", "CreateSkill", "DeleteSkill"]
  return !technicalTools.includes(toolName)
}

export async function* runAgentLoop(
  session: SessionRecord,
  rootDir: string,
  executeTool: (tool: string, input: Record<string, unknown>, context: ToolContext, toolUseId?: string) => Promise<unknown>,
  context: ToolContext,
  options?: {
    logger?: Logger
    abortSignal?: AbortSignal
    bootstrap?: WorkspaceBootstrapContext
    systemPromptOverride?: string
    maxIterations?: number
    maxTurnDurationMs?: number
    maxTokens?: number
    costState?: CostState
    contextExtras?: ContextExtras
    turnStartedAt?: number
  },
): AsyncGenerator<AgentLoopEvent, AssistantTurnResult> {
  const logger = getLogger(context, options?.logger)
  const startedAt = options?.turnStartedAt ?? Date.now()
  const maxIterations = options?.maxIterations ?? MAX_TURN_ITERATIONS
  const maxTurnDurationMs = options?.maxTurnDurationMs ?? DEFAULT_MAX_TURN_DURATION_MS
  let config = { ...getEffectiveModelConfig(), sessionId: session.id }
  const isSubAgent = session.id.startsWith("agent-")
  let activeSession = session
  let compacted = false
  let compactionCount = 0
  let coherenceFailureCount = 0
  const MAX_COMPACTIONS_PER_TURN = 3
  let usage: TurnUsage | undefined
  const steps: AssistantTurnStep[] = []
  const messages = sessionToMessages(session)
  const executionStack = new TurnExecutionStack()
  const operationalFailures = new Map<string, number>()

  const lastUserText = getLastUserMessage(session)
  // Full Tool Access Model: Expose all tools directly to the agent.
  // We completely disable RAG semantic tool pre-filtering to prevent tool-blindness.
  let allowedToolNames: string[] | undefined = undefined;


  let recalledProfileFacts: string[] = []
  if (lastUserText && lastUserText.trim().length >= 15) {
    try {
      const { recallProfileFacts } = await import("../session/store.ts")
      recalledProfileFacts = await recallProfileFacts(rootDir, lastUserText, context.profileId ?? "default")
    } catch (err) {
      logger.warn(`Failed to semantically recall profile facts: ${err}`)
    }
  }

  let blockedTools: string[] = []
  if (isSubAgent && lastUserText) {
    try {
      const classification = await classifyTaskRequiredCapabilities(rootDir, lastUserText)
      blockedTools = classification.blockedTools
    } catch (err) {
      logger.warn(`Failed to classify task required capabilities: ${err}`)
    }
  }

  const prompt = buildSystemPrompt({
    session: activeSession,
    rootDir,
    context,
    bootstrap: options?.bootstrap,
    extras: {
      ...options?.contextExtras,
      blockedTools
    },
    systemPromptOverride: options?.systemPromptOverride,
    allowedToolNames,
    recalledProfileFacts,
  })

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    enforceBudgetLimit(options?.costState, config.model)
    yield { type: "setup", sessionId: session.id, iteration, model: config.model, maxIterations, maxTurnDurationMs }

    if (iteration === maxIterations && !isSubAgent) {
      if (context.orchestrator) {
        try {
          const lastUserMsg = session.messages.filter(m => m.role === "user").slice(-1)[0]?.text ?? "Tarea original";
          
          // Sintetizar explicación del objetivo técnico usando el modelo de lenguaje de background
          const recentChat = session.messages.slice(-10).map(m => `[${m.role.toUpperCase()}]: ${m.text}`).join("\n");
          const goalExplanation = await runBackgroundTextTask(
            rootDir,
            "Eres el sintetizador de traspaso de Monolito V2. Tu tarea es analizar el historial reciente de chat e identificar con precisión el objetivo técnico real que el usuario y el asistente están intentando resolver. Genera una explicación técnica corta, directa y sin introducciones sobre el objetivo que el sub-agente debe completar.",
            `Historial reciente de chat:\n${recentChat}`,
            { logger }
          ).then(r => r.text).catch(() => "Completar la tarea original solicitada por el usuario en el chat.");

          const handoffContext = compileHandoffTranscript(session, messages, goalExplanation);
          const spawned = await context.orchestrator.spawnBackgroundTask(
            session.id,
            context.profileId ?? "default",
            `Completar la tarea original: ${lastUserMsg}`,
            `Auto-delegation from turn limit`,
            undefined,
            { injected_context: handoffContext }
          );

          const finalText = `⚠️ **Autodelegación por límite de turnos (16/16)**\n\n` +
            `Para evitar bloquear este chat y no perder el progreso del refactor/análisis actual, he delegado el resto del trabajo a un sub-agente en segundo plano (Job ID: \`${spawned.agentId}\`) con todo el contexto, código modificado y herramientas utilizadas hasta el momento.\n\n` +
            `Te notificaré de forma autónoma apenas esté 100% verificado y completado. ¡No te preocupes por nada!`;

          const result = finalize(finalText, steps, startedAt, iteration, usage, undefined, "completed");
          yield { type: "done", sessionId: session.id, result };
          return result;
        } catch (spawnErr) {
          logger.error(`Auto-delegation failed: ${spawnErr}`);
        }
      }
    }

    if (options?.abortSignal?.aborted) {
      const result = finalize("", steps, startedAt, iteration - 1, usage, undefined, "aborted")
      yield { type: "done", sessionId: session.id, result }
      return result
    }
    if (Date.now() - startedAt > maxTurnDurationMs) {
      const result = finalize("", steps, startedAt, iteration - 1, usage, "Turn duration exceeded", "max_duration")
      yield { type: "done", sessionId: session.id, result }
      return result
    }
    try {
      const budget = getContextBudget(config.model)
      const estimatedTokens = estimateContextTokens(prompt.system, messages)
      if (estimatedTokens > budget.compactTriggerTokens) {
        if (compactionCount < MAX_COMPACTIONS_PER_TURN) {
          compactionCount++
          yield {
            type: "recoverable_error",
            sessionId: session.id,
            iteration,
            action: "compact_context",
            error: `Proactive smart context compaction (Estimated tokens: ${estimatedTokens} > ${budget.compactTriggerTokens})`
          }

          // Step 1: In-memory Tier 1 compaction of tool results
          const inMemBudgetChars = budget.compactTriggerTokens * 3.5
          const inMemResult = compactInMemoryTier1(messages, inMemBudgetChars)
          if (inMemResult.freedChars > 0) {
            messages.splice(0, messages.length, ...inMemResult.messages)
            logger.info(`[context-engine] Proactive Tier 1 (in-memory) freed ${inMemResult.freedChars} chars.`)
          }

          // Step 2: Proactive Tier 2 (LLM Summary of DB messages)
          const currentEstimated = estimateContextTokens(prompt.system, messages)
          if (currentEstimated > budget.compactTriggerTokens) {
            logger.info(`[context-engine] Proactive Tier 1 not enough (${currentEstimated} > ${budget.compactTriggerTokens}). Launching Tier 2 DB compaction...`)
            const compResult = await smartCompactSession(rootDir, session.id)
            if (compResult.compacted) {
              const refreshed = getSession(rootDir, session.id)
              if (refreshed) {
                activeSession = refreshed
                // Reload DB history but preserve current turn's assistant and tool messages!
                const currentTurnMessages = messages.filter(m => m.role === "assistant" || m.role === "tool")
                messages.splice(0, messages.length, ...sessionToMessages(refreshed), ...currentTurnMessages)
              }
            }
          }
        } else {
          logger.warn(`[context-engine] Proactive compaction skipped: reached MAX_COMPACTIONS_PER_TURN (${MAX_COMPACTIONS_PER_TURN})`)
        }
      }

      yield { type: "model_invoke_start", sessionId: session.id, iteration, model: config.model }
      let response: ProviderResponse | null = null
      for await (const event of callProviderWithRetry(config, prompt, messages, options?.abortSignal, isSubAgent, options?.maxTokens)) {
        throwIfAborted(options?.abortSignal)
        switch (event.type) {
          case "token":
            if (event.content) yield { type: "model_stream", sessionId: session.id, iteration, text: redactSensitiveText(event.content) }
            break
          case "tool_call":
            break
          case "retry_backoff":
            yield { type: "recoverable_error", sessionId: session.id, iteration, action: "backoff", error: event.error, retryAfterMs: event.retryAfterMs }
            break
          case "response":
            response = event.response
            break
        }
      }
      if (!response) throw new Error("Provider generator completed without a response")
      enforceBudgetLimit(options?.costState, config.model, response.usage)
      usage = sumUsage(usage, response.usage)
      const loopUsage = response.usage ? {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0),
      } : undefined
      yield { type: "model_invoke_end", sessionId: session.id, iteration, usage: loopUsage, toolCallCount: response.toolCalls.length }

      const toolsThisTurn = response.toolCalls.map((tc) => tc.name)

      if (response.toolCalls.length === 0) {
        // --- TDD FINALIZATION GUARD ---
        let lastFailureTool = ""
        let failureSnippet = ""
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i]
          if (msg.role === "user") break
          if (msg.role === "tool") {
            if (msg.toolName === "Bash") {
              const hasExitCode = msg.content.includes('"exitCode":')
              const isZero = msg.content.includes('"exitCode": 0')
              if (hasExitCode && !isZero) {
                lastFailureTool = "Bash"
                failureSnippet = extractErrorText(msg.content)
              }
              break
            }
            if (msg.content.includes('status="error"') && !isOperationalTool(msg.toolName)) {
              lastFailureTool = msg.toolName
              failureSnippet = extractErrorText(msg.content)
              break
            }
            break
          }
        }

        if (lastFailureTool) {
          yield {
            type: "recoverable_error",
            sessionId: session.id,
            iteration,
            action: "tdd_correction",
            error: `Intento de finalización bloqueado preventivamente por fallo no resuelto en la herramienta "${lastFailureTool}".`
          }
          logger.warn(`[tdd-react] Rejecting turn finalization because of unresolved tool failure in "${lastFailureTool}".`)
          
          let semanticHelper = ""
          try {
            const matched = await querySimilarErrors(rootDir, failureSnippet)
            if (matched) {
              semanticHelper = `\n\n[PALACE MEMORY]: Un error similar ocurrió en el pasado y fue resuelto con éxito.
- Error Histórico: "${matched.error}"
- Solución Aplicada: "${matched.solution}"
Considera esta estrategia de solución.`
            }
          } catch {}

          messages.push({
            role: "user",
            content: `[SYSTEM ALERT - TDD FAIL-SAFE] Tu respuesta ha sido RECHAZADA.
No puedes dar por finalizada la tarea porque el último comando o prueba ejecutada en este turno falló (error de herramienta "${lastFailureTool}" o exitCode != 0).
Debes corregir el código del workspace y ejecutar con éxito las pruebas correspondientes antes de responder al usuario.${semanticHelper}`
          })
          continue
        }

        // --- COHERENCE GUARD VERIFICATION ---
        const profileId = context.profileId || "default";
        const coherence = await checkTurnCoherence(
          rootDir,
          response.text,
          profileId,
          runBackgroundTextTask,
          session.messages.slice(-3)
        );

        if (!coherence.coherent) {
          coherenceFailureCount++
          if (coherenceFailureCount >= 3) {
            logger.warn(`Coherence guard bypassed for session ${session.id} after 3 failed corrections to prevent hard timeout. Reason: ${coherence.reason}`);
            appendWorklog(rootDir, session.id, {
              type: "note",
              summary: `COHERENCE_GUARD_BYPASSED: Bypassed after 3 consecutive rejections to prevent turn timeout. Last reason: "${coherence.reason}"`,
            });
          } else {
            logCoherenceBreach(rootDir, session.id, coherence.reason ?? "Incoherencia de perfil", response.text);

            yield {
              type: "recoverable_error",
              sessionId: session.id,
              iteration,
              action: "coherence_correction" as any,
              error: `Respuesta rechazada por coherencia: ${coherence.reason}`
            };

            messages.push({
              role: "user",
              content: `[SYSTEM ALERT - COHERENCE GUARD] Tu respuesta anterior fue RECHAZADA.
Contradicción detectada: ${coherence.reason}
Por favor, corregí este error de inmediato y reescribí tu respuesta respetando estrictamente tu memoria.`
            });

            continue;
          }
        }
        // --- END OF COHERENCE GUARD ---

        // --- UNIFIED INTEGRITY GUARD VERIFICATION ---
        try {
          const toolsCalledInTurn = steps
            .filter(step => step.type === "tool")
            .map(step => (step as { type: "tool"; tool: string }).tool)

          const integrity = await checkTurnIntegrity(
            rootDir,
            response.text,
            toolsCalledInTurn,
            runBackgroundTextTask
          );

          if (!integrity.verified) {
            if (integrity.type === "falsified_execution") {
              logVeracityBreach(rootDir, session.id, integrity.reason ?? "Mismatch de ejecución detectado", response.text);

              yield {
                type: "recoverable_error",
                sessionId: session.id,
                iteration,
                action: "veracity_correction" as any,
                error: `Respuesta rechazada por veracidad: ${integrity.reason}`
              };

              messages.push({
                role: "user",
                content: `[SYSTEM ALERT - VERACITY GUARD] Tu respuesta anterior fue RECHAZADA.
Afirmas haber ejecutado comandos de consola, scripts, o transferencias de archivos en este turno, pero no realizaste las llamadas a herramientas reales correspondientes.
No inventes ni alucines resultados. Por favor, ejecuta las herramientas reales (como Bash) para realizar la acción, o corrige tu respuesta para reflejar lo que realmente hiciste.`
              });
            } else if (integrity.type === "broken_promise") {
              logBrokenPromise(rootDir, session.id, integrity.reason ?? "Promesa rota detectada", response.text);

              yield {
                type: "recoverable_error",
                sessionId: session.id,
                iteration,
                action: "commitment_correction" as any,
                error: `Respuesta rechazada por promesa rota: no se llamó a ninguna herramienta para cumplir el compromiso.`
              };

              messages.push({
                role: "user",
                content: `[SYSTEM ALERT - COMMITMENT GUARD] Tu respuesta anterior fue RECHAZADA.
Promesa rota/falsa detectada: Prometiste realizar una acción, buscar información, enviar archivos o realizar una tarea (ej. "Buscando ahora mismo...", "Dame un toque", "En un momento te las mando", "revisando...", etc.) pero finalizaste el turno sin ejecutar ninguna herramienta ni delegar la tarea.
Por favor, si vas a realizar la acción ahora mismo, ejecutá las herramientas correspondientes (ej. ImageSearch, TelegramSendPhoto, Bash, etc.) en este mismo turno ANTES de dar tu respuesta final. Si es una acción diferida, debés usar delegate_background_task o schedule_task. No hagas promesas vacías en tu texto final.`
              });
            }

            continue;
          }
        } catch (integrityErr) {
          logger.warn(`Integrity guard check failed: ${integrityErr}`);
        }
        // --- END OF UNIFIED INTEGRITY GUARD ---

        await detectAndSaveLearning(rootDir, messages, logger)
        const finalizeResult = finalize(response.text, steps, startedAt, iteration, usage)
        yield { type: "done", sessionId: session.id, result: finalizeResult }
        return finalizeResult
      }
      const assistantMessage: ConversationMessage = { role: "assistant", content: response.text, toolCalls: response.toolCalls }
      messages.push(assistantMessage)
      for (const toolCall of response.toolCalls) {
        steps.push({ type: "tool", id: toolCall.id, tool: toolCall.name, input: toolCall.input })
      }

      const indexedToolCalls = response.toolCalls.map((toolCall, index) => ({ toolCall, index }))
      const safeToolCalls = indexedToolCalls.filter(({ toolCall }) => isToolConcurrencySafe(toolCall.name, toolCall.input))
      const unsafeToolCalls = indexedToolCalls.filter(({ toolCall }) => !isToolConcurrencySafe(toolCall.name, toolCall.input))
      const toolResults = new Array<{ role: "tool"; toolCallId: string; toolName: string; content: string }>(response.toolCalls.length)

      for (const { toolCall } of safeToolCalls) {
        if (!isToolSideEffect(toolCall.name)) {
          yield { type: "tool_execute_start", sessionId: session.id, iteration, toolUseId: toolCall.id, tool: toolCall.name, input: toolCall.input }
        }
      }
      const safeResults = await Promise.all(
        safeToolCalls.map(async ({ toolCall, index }) => {
          if (isToolSideEffect(toolCall.name)) {
            executionStack.push(toolCall, index)
            const content = formatToolEvidenceResult(toolCall, "success", {
              status: "buffered",
              message: `Herramienta '${toolCall.name}' encolada. Se ejecutará tras validación.`
            })
            return {
              index,
              toolCall,
              stalled: false,
              buffered: true,
              message: {
                role: "tool" as const,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content,
              },
            }
          }
          const stall = isToolCallStalled(messages, toolCall.name, toolCall.input)
          if (stall.stalled) {
            const content = formatToolEvidenceResult(toolCall, "error", {
              error: `SYSTEM BLOCK: La herramienta '${toolCall.name}' ha sido bloqueada preventivamente por el motor de Monolito V2 tras ${stall.count} ejecuciones idénticas en este turno. Cambia de estrategia.`
            })
            return {
              index,
              toolCall,
              stalled: true,
              buffered: false,
              message: {
                role: "tool" as const,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content,
              },
            }
          }
          const result = await executeToolCall(toolCall, executeTool, context)
          return {
            index,
            toolCall,
            stalled: false,
            buffered: false,
            message: {
              role: "tool" as const,
              toolCallId: result.toolCall.id,
              toolName: result.toolCall.name,
              content: result.content,
            },
          }
        }),
      )
      for (const result of safeResults) {
        if (result.stalled) {
          yield {
            type: "recoverable_error",
            sessionId: session.id,
            iteration,
            action: "stall_blocking",
            error: `Bloqueo preventivo de Stall Guard en herramienta "${result.toolCall.name}"`
          }
        }
        if (result.buffered) {
          // No yield start/end yet
        } else {
          yield { type: "tool_execute_end", sessionId: session.id, iteration, toolUseId: result.toolCall.id, tool: result.toolCall.name, ok: !result.message.content.includes('status="error"') }
          if (!result.message.content.includes('status="error"')) {
            executionStack.recordSuccess(result.toolCall.name)
          }
        }
        toolResults[result.index] = result.message
      }

      for (const { toolCall, index } of unsafeToolCalls) {
        if (isToolSideEffect(toolCall.name)) {
          executionStack.push(toolCall, index)
          const content = formatToolEvidenceResult(toolCall, "success", {
            status: "buffered",
            message: `Herramienta '${toolCall.name}' encolada. Se ejecutará tras validación.`
          })
          toolResults[index] = {
            role: "tool",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content,
          }
          continue
        }

        const stall = isToolCallStalled(messages, toolCall.name, toolCall.input)
        if (stall.stalled) {
          const content = formatToolEvidenceResult(toolCall, "error", {
            error: `SYSTEM BLOCK: La herramienta '${toolCall.name}' ha sido bloqueada preventivamente por el motor de Monolito V2 tras ${stall.count} ejecuciones idénticas en este turno. Cambia de estrategia.`
          })
          yield {
            type: "recoverable_error",
            sessionId: session.id,
            iteration,
            action: "stall_blocking",
            error: `Bloqueo preventivo de Stall Guard en herramienta "${toolCall.name}"`
          }
          toolResults[index] = {
            role: "tool",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content,
          }
          continue
        }

        yield { type: "tool_execute_start", sessionId: session.id, iteration, toolUseId: toolCall.id, tool: toolCall.name, input: toolCall.input }
        const result = await executeToolCall(toolCall, executeTool, context)
        yield { type: "tool_execute_end", sessionId: session.id, iteration, toolUseId: toolCall.id, tool: toolCall.name, ok: !result.content.includes('status="error"') }
        if (!result.content.includes('status="error"')) {
          executionStack.recordSuccess(toolCall.name)
        }
        toolResults[index] = {
          role: "tool",
          toolCallId: result.toolCall.id,
          toolName: result.toolCall.name,
          content: result.content,
        }
      }

      // Evaluador de side effects
      if (executionStack.hasPending()) {
        const evaluation = await checkSideEffects(
          rootDir,
          executionStack.pending().map(b => ({
            name: b.toolCall.name,
            input: b.toolCall.input,
          })),
          executionStack.executedTools(),
          context.profileId || "default",
          lastUserText || "",
          runBackgroundTextTask,
        )

        if (evaluation.approved) {
          // ✅ Flush: ejecutar todas las buffereadas
          for (const buffered of executionStack.pending()) {
            yield { type: "tool_execute_start", sessionId: session.id, iteration, toolUseId: buffered.toolCall.id, tool: buffered.toolCall.name, input: buffered.toolCall.input }
            const result = await executeToolCall(buffered.toolCall, executeTool, context)
            yield { type: "tool_execute_end", sessionId: session.id, iteration, toolUseId: buffered.toolCall.id, tool: buffered.toolCall.name, ok: !result.content.includes('status="error"') }
            // Reemplazar placeholder con resultado real
            toolResults[buffered.index] = {
              role: "tool",
              toolCallId: result.toolCall.id,
              toolName: result.toolCall.name,
              content: result.content,
            }
            if (!result.content.includes('status="error"')) {
              executionStack.recordSuccess(buffered.toolCall.name)
            }
          }
        } else {
          // ❌ Rechazado: reemplazar placeholders con error de policy
          for (const buffered of executionStack.pending()) {
            toolResults[buffered.index] = {
              role: "tool",
              toolCallId: buffered.toolCall.id,
              toolName: buffered.toolCall.name,
              content: formatToolEvidenceResult(buffered.toolCall, "blocked", {
                error: `[Side-Effect Guard] Ejecución bloqueada: ${evaluation.reason}`
              }),
            }
          }
          appendWorklog(rootDir, session.id, {
            type: "note",
            summary: `SIDE_EFFECT_GUARD_BLOCKED: ${evaluation.reason}`,
          })
        }
        executionStack.clearBuffer()
      }

      for (const toolResult of toolResults) {
        if (!toolResult) continue
        messages.push(toolResult)

        const isOp = isOperationalTool(toolResult.toolName)
        const isFail = toolResult.content.includes('status="error"') || 
                       (toolResult.toolName === "Bash" && toolResult.content.includes('"exitCode":') && !toolResult.content.includes('"exitCode": 0'))
        
        if (isFail && isOp) {
          const count = (operationalFailures.get(toolResult.toolName) ?? 0) + 1
          operationalFailures.set(toolResult.toolName, count)
          if (count >= 2) {
            yield {
              type: "recoverable_error",
              sessionId: session.id,
              iteration,
              action: "operational_interruption" as any,
              error: `Interrupción operacional al alcanzar ${count} fallos consecutivos en "${toolResult.toolName}".`
            }
            messages.push({
              role: "user",
              content: `[SYSTEM ALERT - OPERATIONAL INTERRUPTION] La herramienta "${toolResult.toolName}" está fallando de forma persistente con el error: "${extractErrorText(toolResult.content)}".
No intentes ejecutarla más en este turno. Por favor, detén la ejecución en este paso y explícale con total transparencia al usuario qué está pasando para que sea él quien decida cómo proceder.`
            })
          }
        } else if (!isFail && isOp) {
          operationalFailures.set(toolResult.toolName, 0)
        }
      }

      // --- TDD-REACT FAIL-SAFE ALERTS ---
      let commandOrTestFailure = false
      let failedToolName = ""
      let failureSnippet = ""
      for (const res of toolResults) {
        if (!res) continue
        if (res.toolName === "Bash" && (res.content.includes('"exitCode":') && !res.content.includes('"exitCode": 0'))) {
          commandOrTestFailure = true
          failedToolName = "Bash"
          failureSnippet = extractErrorText(res.content)
          break
        }
        if (res.content.includes('status="error"') && !isOperationalTool(res.toolName)) {
          commandOrTestFailure = true
          failedToolName = res.toolName
          failureSnippet = extractErrorText(res.content)
          break
        }
      }

      if (commandOrTestFailure) {
        yield {
          type: "recoverable_error",
          sessionId: session.id,
          iteration,
          action: "tdd_correction",
          error: `Fallo detectado en la ejecución de la herramienta "${failedToolName}".`
        }
        logger.warn(`[tdd-react] Execution failure detected on tool "${failedToolName}". Querying Memory Palace...`)
        
        let semanticHelper = ""
        try {
          const matched = await querySimilarErrors(rootDir, failureSnippet)
          if (matched) {
            semanticHelper = `\n\n[PALACE MEMORY]: Un error similar ocurrió en el pasado y fue resuelto con éxito.
- Error Histórico: "${matched.error}"
- Solución Aplicada: "${matched.solution}"
Considera esta estrategia de solución.`
            logger.info(`[tdd-react] Semantic error recovery found a matching solution for "${failedToolName}".`)
          }
        } catch (err) {
          logger.warn(`Failed semantic query for tool failure: ${err}`)
        }

        messages.push({
          role: "user",
          content: `[SYSTEM ALERT - TDD-REACT FAIL-SAFE] Se detectó un fallo de ejecución en la herramienta "${failedToolName}".
Si esto corresponde a un error de compilación, una excepción no controlada o una prueba unitaria rota (FAIL/tests failed), debes analizar con absoluta precisión el log de error anterior, localizar el archivo fuente correspondiente en el workspace y aplicar la corrección técnica en este mismo turno. No ignores el error ni finalices el turno diciendo que completaste la tarea sin haber resuelto y verificado exitosamente el problema.${semanticHelper}`
        })
      }

      checkTurnIntegrity(rootDir, response.text, toolsThisTurn, runBackgroundTextTask)
        .then((result) => {
          if (!result.verified && result.type === "broken_promise") {
            logBrokenPromise(rootDir, session.id, result.reason ?? "Promesa rota", response.text)
          }
        })
        .catch(() => {/* silent */})
    } catch (error) {
      if (options?.abortSignal?.aborted) {
        const result = finalize("", steps, startedAt, Math.max(0, steps.length), usage, undefined, "aborted")
        yield { type: "done", sessionId: session.id, result }
        return result
      }
      if (error instanceof ContextOverflowError) {
        if (compactionCount < MAX_COMPACTIONS_PER_TURN) {
          compactionCount++
          yield { type: "recoverable_error", sessionId: session.id, iteration, action: "compact_context", error: `ContextOverflowError: ${error.message}. Running smart recovery cascade (${compactionCount}/${MAX_COMPACTIONS_PER_TURN})...` }
          
          logger.info(`[context-engine] ContextOverflowError caught. Initiating smart DB Tier 2 compaction...`)
          const compResult = await smartCompactSession(rootDir, session.id, { forceTier2: true })
          if (compResult.compacted) {
            logger.info(`[context-engine] DB compaction freed ${compResult.freedChars} chars.`)
          }

          // In-memory Tier 1 compaction of tool results to be absolutely sure we fit
          const budget = getContextBudget(config.model)
          const inMemBudgetChars = budget.compactTriggerTokens * 3.5
          const inMemResult = compactInMemoryTier1(messages, inMemBudgetChars)
          if (inMemResult.freedChars > 0) {
            messages.splice(0, messages.length, ...inMemResult.messages)
            logger.info(`[context-engine] In-memory Tier 1 compaction freed ${inMemResult.freedChars} chars.`)
          }

          const refreshed = getSession(rootDir, session.id)
          if (refreshed) {
            activeSession = refreshed
            const currentTurnMessages = messages.filter(m => m.role === "assistant" || m.role === "tool")
            messages.splice(0, messages.length, ...sessionToMessages(refreshed), ...currentTurnMessages)
          }
          compacted = true
          continue
        } else {
          // Anti-thrash threshold reached
          const snapshotPath = saveEmergencySnapshot(rootDir, session.id, messages)
          logger.error(`[context-engine] Context overflow unrecoverable after ${MAX_COMPACTIONS_PER_TURN} compaction attempts. Session snapshot saved to: ${snapshotPath}`)
          throw new Error(`Context overflow unrecoverable after ${MAX_COMPACTIONS_PER_TURN} compaction attempts. Session snapshot saved to: ${snapshotPath}`)
        }
      }
      if (error instanceof AbortError) throw error
      logger.error("assistant turn failed", { error: error instanceof Error ? error.message : String(error), sessionId: session.id })
      const message = error instanceof Error ? error.message : String(error)
      const result = finalize(message, steps, startedAt, Math.min(maxIterations, steps.length + 1), usage, message)
      yield { type: "done", sessionId: session.id, result }
      return result
    }
  }
  const result = finalize("", steps, startedAt, maxIterations, usage, "Max iterations reached", "max_iterations")
  yield { type: "done", sessionId: session.id, result }
  return result
}

export function isToolCallStalled(
  messages: ConversationMessage[],
  toolName: string,
  toolInput: Record<string, unknown>
): { stalled: boolean; count: number } {
  const targetArgs = JSON.stringify(toolInput)
  let count = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") {
      break // Reseteo de contexto en cada frontera de mensaje del usuario real
    }
    if (msg.role === "assistant" && "toolCalls" in msg) {
      const assistantMsg = msg as { toolCalls?: any[] }
      if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
        for (const tc of assistantMsg.toolCalls) {
          if (tc.name === toolName && JSON.stringify(tc.input) === targetArgs) {
            count++
          }
        }
      }
    }
  }

  return { stalled: count >= 3, count }
}

function extractErrorText(content: string): string {
  const stderrMatch = content.match(/"stderr":\s*"([\s\S]*?)"/)
  if (stderrMatch && stderrMatch[1]) {
    try {
      const decoded = JSON.parse(`"${stderrMatch[1]}"`)
      if (decoded.trim()) return decoded.trim()
    } catch {
      return stderrMatch[1].trim()
    }
  }
  const lines = content.split("\n")
  return lines.slice(-10).join("\n").trim()
}

async function detectAndSaveLearning(rootDir: string, messages: ConversationMessage[], logger: Logger) {
  try {
    let userMessageIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        userMessageIndex = i
        break
      }
    }
    if (userMessageIndex === -1) return

    const turnMessages = messages.slice(userMessageIndex + 1)
    
    let firstFailedError = ""
    let hasEdits = false
    let lastSuccessCmd = ""
    let editSummaries: string[] = []

    for (const msg of turnMessages) {
      if (msg.role === "assistant" && "toolCalls" in msg) {
        const astMsg = msg as { toolCalls?: ToolCall[] }
        if (astMsg.toolCalls) {
          for (const tc of astMsg.toolCalls) {
            if (tc.name === "Write" || tc.name === "Edit") {
              hasEdits = true
              editSummaries.push(`${tc.name} en ${(tc.input as any).path ?? "archivo"}`)
            }
          }
        }
      }
      if (msg.role === "tool") {
        const toolRes = msg as { toolName?: string; content: string }
        const isFail = toolRes.content.includes('status="error"') || (toolRes.toolName === "Bash" && toolRes.content.includes('"exitCode":') && !toolRes.content.includes('"exitCode": 0'))
        const isSuccess = toolRes.toolName === "Bash" && toolRes.content.includes('"exitCode": 0')
        
        if (isFail && !firstFailedError) {
          firstFailedError = extractErrorText(toolRes.content)
        }
        if (isSuccess && firstFailedError && hasEdits) {
          lastSuccessCmd = `Ejecución exitosa de comando: ${toolRes.toolName ?? "Bash"}`
        }
      }
    }

    if (firstFailedError && hasEdits && lastSuccessCmd) {
      const solutionSummary = `Se solucionó aplicando: ${editSummaries.join(", ")}. Verificado con: ${lastSuccessCmd}.`
      logger.info(`[tdd-react] Learning loop detected a resolved issue! Saving to Memory Palace...`)
      await saveResolvedError(rootDir, firstFailedError, solutionSummary)
    }
  } catch (err) {
    logger.warn(`Failed to detect/save learning from turn: ${err}`)
  }
}

export async function runAssistantTurn(
  session: SessionRecord,
  rootDir: string,
  executeTool: (tool: string, input: Record<string, unknown>, context: ToolContext, toolUseId?: string) => Promise<unknown>,
  context: ToolContext,
  options?: {
    logger?: Logger
    abortSignal?: AbortSignal
    bootstrap?: WorkspaceBootstrapContext
    systemPromptOverride?: string
    maxIterations?: number
    maxTurnDurationMs?: number
    maxTokens?: number
    costState?: CostState
    contextExtras?: ContextExtras
    turnStartedAt?: number
  },
): Promise<AssistantTurnResult> {
  let finalResult: AssistantTurnResult | null = null
  const generator = runAgentLoop(session, rootDir, executeTool, context, options)
  while (true) {
    const next = await generator.next()
    if (next.done) {
      finalResult = next.value
      break
    }
    const event = next.value as AgentLoopEvent
    if (event.type === "done") finalResult = event.result
  }
  return finalResult ?? finalize("", [], options?.turnStartedAt ?? Date.now(), 0, undefined, "Agent loop finished without a result")
}

export async function runBackgroundTextTask(
  _rootDir: string,
  system: string,
  userPrompt: string,
  options?: { model?: string; maxTokens?: number; abortSignal?: AbortSignal; logger?: Logger },
): Promise<{ text: string; usage?: TurnUsage }> {
  const config = { ...getEffectiveModelConfig() }
  const prompt = { system, bootBlock: "" }
  const messages: ConversationMessage[] = [{ role: "user", content: userPrompt }]
  const events = callProviderWithRetry(
    { ...config, model: options?.model?.trim() || config.model },
    prompt,
    messages,
    options?.abortSignal,
    false,
    options?.maxTokens ?? MAX_BACKGROUND_TOKENS,
  )
  let finalResponse: ProviderResponse | null = null
  for await (const event of events) {
    throwIfAborted(options?.abortSignal)
    if (event.type === "response") finalResponse = event.response
  }
  if (!finalResponse) throw new Error("Provider generator completed without a response")
  return { text: finalResponse.text, usage: finalResponse.usage }
}

export async function classifyTaskRequiredCapabilities(
  rootDir: string,
  taskDescription: string
): Promise<{ blockedTools: string[] }> {
  if (!taskDescription.trim()) return { blockedTools: [] }
  try {
    const systemPrompt = `You are a security and resource auditor for an AI agent runtime.
Analyze the user's task description and determine if we should restrict/block certain powerful tools (like "Bash", "Write", "Edit", "MultiEdit") for safety, focus, or token budget.

CRITICAL SECURITY RULES:
- If the task is restricted, highly focused, or purely media/information gathering (e.g. searching/processing specific visual assets, transcription, speech generation) and does NOT require writing code, modifying workspace files, running builds, running tests, or executing shell commands, you should block the powerful technical tools: ["Bash", "Write", "Edit", "MultiEdit", "TodoWrite", "TodoUpdate"].
- If the task requires system administration, SSH, running shell commands, writing/editing code, running tests, or modifying files, do NOT block "Bash", "Write", or "Edit".
- Ignore default system boilerplate warnings or guidelines. Only analyze the user's core objective.

Respond ONLY with a valid JSON object in this format:
{
  "blockedTools": ["ToolName1", "ToolName2"],
  "reason": "brief explanation"
}`
    const userPrompt = `Task description: "${taskDescription}"`
    const { text } = await runBackgroundTextTask(rootDir, systemPrompt, userPrompt, { maxTokens: 150 })
    const parsed = JSON.parse(text.trim())
    return {
      blockedTools: Array.isArray(parsed.blockedTools) ? parsed.blockedTools : []
    }
  } catch (err) {
    // Fail-safe: no herramientas bloqueadas si el clasificador falla
    return { blockedTools: [] }
  }
}
