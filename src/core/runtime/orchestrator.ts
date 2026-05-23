import { randomUUID } from "node:crypto"
import { type MonolitoV2Runtime } from "./runtime.ts"
import { ensureDirs } from "../ipc/protocol.ts"
import {
  appendMessage,
  appendWorklog,
  claimBackgroundTask,
  createBackgroundTask,
  createWorkerSessionAndJob,
  createProfile,
  getBackgroundTask,
  getSession,
  getDb,
  listBackgroundTasks,
  listProfiles,
  listRecoverableWorkerJobs,
  tailEvents,
  updateBackgroundTaskStatus,
  updateWorkerJobStatus,
  upsertWorkerJob,
  listSessionTasks,
} from "../session/store.ts"
import { createInstanceLogger, createLogger, type Logger } from "../logging/logger.ts"

const logger = createLogger("orchestrator")
import { createAgentWorktree, removeAgentWorktree } from "../context/gitContext.ts"
import { monolitoEvents } from "../events/bus.ts"

const SUBAGENT_VERIFICATION_TAG = "<verified>SUCCESS</verified>"
const SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000
const SUBAGENT_HARD_TIMEOUT_MS = 15 * 60 * 1000
const WORKER_IMAGE_EXECUTION_POLICY = [
  "Image-search execution policy:",
  "- Para busquedas simples de imagenes, usa ImageSearch y devuelve `image_url` directas. No uses WebFetch ni scraping de paginas fuente.",
  "- Solo usa AnalyzeImage cuando la tarea pida explicitamente verificar, validar, analizar o describir el contenido visual.",
  "- Si AnalyzeImage confirma que la imagen no coincide, descarta ese resultado y proba la siguiente `image_url` de la lista.",
  "- No crees perfiles, archivos de plan ni tareas auxiliares para buscar imagenes. Ejecuta el camino mas corto.",
].join("\n")

function normalizeForIntent(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
}

function isImageTaskIntent(...values: Array<string | undefined>) {
  const normalized = normalizeForIntent(values.filter(Boolean).join(" "))
  return /\b(imagen(?:es)?|foto(?:s)?|picture(?:s)?|photo(?:s)?|image(?:s)?|vision|visual)\b/.test(normalized)
}

function requiresImageVerification(...values: Array<string | undefined>) {
  const normalized = normalizeForIntent(values.filter(Boolean).join(" "))
  return /\b(verifica(?:r|me|las|los)?|valid(?:a|ar|ame|alas|alos)|analiza(?:r|me|las|los)?|describe(?:me|las|los)?|confirm(?:a|ar|ame)|vision|visual|coincid(?:e|an)|contenido|real(?:es)?|correct(?:a|as|o|os))\b/.test(normalized)
}

const VISION_TOOLS = new Set(["AnalyzeImage", "VisionAnalyze"])

function hasSuccessfulAnalyzeImage(session: ReturnType<typeof getSession>, rootDir: string, sessionId: string) {
  const events = tailEvents(rootDir, sessionId, 80)
  return events.some(e =>
    e.type === "tool.finish" &&
    e.ok === true &&
    VISION_TOOLS.has(e.tool)
  )
}


function extractPartialImageEvidence(rootDir: string, sessionId: string) {
  const events = tailEvents(rootDir, sessionId, 80)
  const imageRows: string[] = []
  const sentRows: string[] = []

  for (const event of events) {
    if (event.type !== "tool.finish" || !event.ok) continue
    const output = event.output as Record<string, unknown> | undefined
    if (event.tool === "AnalyzeImage") {
      const localPath = typeof output?.local_path === "string" ? output.local_path : ""
      const description = typeof output?.description === "string" ? clip(output.description, 220) : ""
      if (localPath) imageRows.push(`- AnalyzeImage ok: ${localPath}${description ? ` | ${description}` : ""}`)
    }
    if (event.tool === "TelegramSendPhoto") {
      sentRows.push(`- TelegramSendPhoto ok: ${clip(JSON.stringify(output ?? {}), 220)}`)
    }
  }

  if (imageRows.length === 0 && sentRows.length === 0) return ""
  return [
    "Partial worker evidence before failure:",
    ...imageRows.slice(-6),
    ...sentRows.slice(-6),
  ].join("\n")
}

function getTaskProgress(rootDir: string, sessionId: string, profileId = "default") {
  const events = tailEvents(rootDir, sessionId, 80)
  
  // 1. Gather cognitive tasks/TODOs progress from SQLite Memory Palace
  let todoSummary = ""
  try {
    const tasks = listSessionTasks(rootDir, sessionId, profileId)
    if (tasks.length > 0) {
      const completed = tasks.filter(t => t.status === "completed").length
      const total = tasks.length
      const pct = Math.round((completed / total) * 100)
      const taskDetails = tasks.map(t => {
        const symbol = t.status === "completed" ? "✓" : (t.status === "in_progress" ? "⏳" : "☐")
        return `${symbol} ${t.content}`
      }).join("; ")
      todoSummary = `Plan cognitivo: ${completed}/${total} completado (${pct}%). Detalles: [${taskDetails}]`
    }
  } catch (e) {
    // Ignore errors querying database
  }

  let imageSearches = 0
  let analyzed = 0
  let telegramSends = 0
  const executedCommands: string[] = []
  const modifiedFiles = new Set<string>()
  let lastAction = ""

  const startEventsMap = new Map<string, unknown>()
  for (const event of events) {
    if (event.type === "tool.start" && event.toolUseId) {
      startEventsMap.set(event.toolUseId, event.input)
    }
  }

  for (const event of events) {
    if (event.type !== "tool.finish" || !event.ok) continue
    const input = event.toolUseId ? startEventsMap.get(event.toolUseId) : undefined
    if (event.tool === "ImageSearch") {
      imageSearches += 1
    } else if (event.tool === "AnalyzeImage") {
      analyzed += 1
    } else if (event.tool === "TelegramSendPhoto") {
      telegramSends += 1
    } else if (event.tool === "Bash") {
      const typedInput = input as Record<string, unknown> | undefined
      const cmd = typeof typedInput?.command === "string" ? typedInput.command : ""
      if (cmd) {
        executedCommands.push(cmd)
        lastAction = `Ejecutó comando en terminal: "${cmd}"`
      }
    } else if (["WriteFile", "EditFile", "ReplaceFileContent", "replace_file_content", "multi_replace_file_content"].includes(event.tool)) {
      const typedInput = input as Record<string, unknown> | undefined
      const path = typeof typedInput?.path === "string" ? typedInput.path : (typeof typedInput?.TargetFile === "string" ? typedInput.TargetFile : "")
      if (path) {
        const fileBasename = path.split("/").pop() ?? path
        modifiedFiles.add(fileBasename)
        lastAction = `Escribió/modificó archivo: "${fileBasename}"`
      }
    } else if (event.tool === "WebSearch" || event.tool === "search_web") {
      const typedInput = input as Record<string, unknown> | undefined
      const query = typeof typedInput?.query === "string" ? typedInput.query : ""
      if (query) {
        lastAction = `Buscó en la web: "${query}"`
      }
    }
  }

  const fileList = Array.from(modifiedFiles)
  const progressDetails: string[] = []

  if (todoSummary) {
    progressDetails.push(todoSummary)
  }
  if (fileList.length > 0) {
    progressDetails.push(`Archivos modificados: ${fileList.join(", ")}`)
  }
  if (executedCommands.length > 0) {
    progressDetails.push(`Comandos ejecutados: ${executedCommands.length} (${executedCommands.slice(-2).join(", ")})`)
  }
  if (imageSearches > 0) progressDetails.push(`${imageSearches} búsquedas de imágenes`)
  if (analyzed > 0) progressDetails.push(`${analyzed} imágenes analizadas`)
  if (telegramSends > 0) progressDetails.push(`${telegramSends} fotos enviadas por Telegram`)
  if (lastAction) {
    progressDetails.push(`Último paso: ${lastAction}`)
  }

  return progressDetails
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function clip(value: string, max = 500) {
  const normalized = compactWhitespace(value)
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`
}

function buildSubagentRetryPrompt(task: string, error: unknown, partialResult?: string) {
  const message = error instanceof Error ? error.message : String(error)
  return [
    task.trim(),
    "",
    WORKER_IMAGE_EXECUTION_POLICY,
    "",
    "Retry the same task with a smaller, more direct execution path.",
    `Technical error: ${clip(message, 240)}`,
    partialResult?.trim() ? `Partial result to keep: ${clip(partialResult, 500)}` : "",
  ].filter(Boolean).join("\n")
}

function hasVerificationTag(text: string | undefined) {
  return typeof text === "string" && text.trimEnd().endsWith(SUBAGENT_VERIFICATION_TAG)
}

function buildRalphLoopPrompt(task: string, assistantReply: string) {
  return [
    task.trim(),
    "",
    "[Ralph Loop] SYSTEM ALERT",
    `Intentaste finalizar sin incluir ${SUBAGENT_VERIFICATION_TAG}.`,
    "No podes cerrar la tarea todavia.",
    "Volvé a trabajar desde evidencia real del workspace o de herramientas ejecutadas en esta sesion.",
    "Si algo no fue verificado, decilo, corregilo y recien despues responde.",
    "No mientas para escapar del loop.",
    "Tu proxima respuesta final debe incluir exactamente el tag requerido.",
    "",
    `Ultimo intento rechazado: ${clip(assistantReply, 500)}`,
  ].join("\n")
}

function buildRalphLoopImagePrompt(task: string, assistantReply: string) {
  return [
    task.trim(),
    "",
    "[Ralph Loop] SYSTEM ALERT",
    "Tu respuesta incluye el tag de éxito pero NO ejecutaste la herramienta AnalyzeImage.",
    "Para tareas de imágenes, es OBLIGATORIO descargar y validar visualmente con AnalyzeImage.",
    "No podés cerrar la tarea diciendo que lo hiciste sin haber llamado a la tool.",
    "Corregilo: buscá la imagen, descargala y pasale la ruta a AnalyzeImage antes de responder.",
    "",
    `Último intento rechazado: ${clip(assistantReply, 500)}`,
  ].join("\n")
}

function buildRalphLoopUnfinishedTasksPrompt(task: string, unfinished: Array<{ content: string; status: string }>, assistantReply: string) {
  const listStr = unfinished.map(t => `- [${t.status.toUpperCase()}] ${t.content}`).join("\n")
  return [
    task.trim(),
    "",
    "[Ralph Loop] SYSTEM ALERT",
    "Intentaste finalizar pero aún tenés tareas pendientes o en progreso en la base de datos cognitiva (Memory Palace):",
    listStr,
    "",
    "No podés cerrar la tarea principal hasta que completes todas las tareas de tu lista.",
    "Para marcar una tarea como completada, utilizá la herramienta TodoUpdate con su taskId.",
    "Si ya las completaste físicamente, acordate de actualizar su estado en la DB antes de salir.",
    "",
    `Último intento rechazado: ${clip(assistantReply, 500)}`,
  ].join("\n")
}

function buildRalphLoopFailingBashPrompt(task: string, command: string, exitCode: number, assistantReply: string) {
  return [
    task.trim(),
    "",
    "[Ralph Loop] SYSTEM ALERT",
    "Intentaste finalizar pero el último comando ejecutado falló:",
    `Comando: ${command}`,
    `Código de salida: ${exitCode}`,
    "",
    "No podés terminar el trabajo si el último comando de verificación (tests, compilación, etc.) falló.",
    "Corregí el problema, verificá que compile o los tests pasen exitosamente (exitCode 0) antes de intentar salir.",
    "",
    `Último intento rechazado: ${clip(assistantReply, 500)}`,
  ].join("\n")
}

function getLatestFailingBashCommand(rootDir: string, sessionId: string) {
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
  return null
}

function createTraceparent() {
  const traceId = randomUUID().replace(/-/g, "")
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16)
  return `00-${traceId}-${spanId}-01`
}


export type DelegationTask = {
  id: string
  parentSessionId: string
  subSessionId: string
  traceId?: string
  profileId: string
  type: "worker" | "researcher" | "verifier"
  mode: "interactive" | "background"
  description: string
  task: string
  injected_context?: string
  status: "pending" | "running" | "completed" | "failed" | "killed"
  jobGroupId?: string
  result?: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  error?: string
  logger?: Logger
  cwd?: string
}

export type SpawnAgentResult = {
  agentId: string
  status: "spawned" | "completed" | "failed" | "killed"
  result?: string
  error?: string
}

export type TaskSnapshot = {
  agentId: string
  description: string
  status: DelegationTask["status"]
  hasResult: boolean
  progress?: string[]
  error?: string
}

const IMMEDIATE_AGENT_SETTLE_MS = 1_500
const MAX_CONCURRENT_WORKERS = 6
const TASK_RETENTION_MS = 5 * 60 * 1000
const SUBAGENT_TOKEN_BUDGET = 80_000


export class AgentOrchestrator {
  private activeTasks = new Map<string, DelegationTask>()
  private runningWorkerCount = 0
  private runtime: MonolitoV2Runtime
  private monitorInterval: NodeJS.Timeout | null = null

  constructor(runtime: MonolitoV2Runtime) {
    this.runtime = runtime
  }

  private startMonitorLoop() {
    if (this.monitorInterval) return
    logger.info("[Worker Monitor] Starting active worker monitoring loop.")
    this.monitorInterval = setInterval(async () => {
      const active = Array.from(this.activeTasks.values()).filter(t => t.status === "pending" || t.status === "running")
      if (active.length === 0) {
        this.stopMonitorLoop()
        return
      }
      for (const task of active) {
        logger.info(`[Worker Monitor] Worker ${task.id} (${task.description}) is in state: ${task.status}`)
        try {
          const recoveredJobs = listRecoverableWorkerJobs(this.runtime.rootDir)
          const dbJob = recoveredJobs.find(j => j.id === task.id)
          if (!dbJob) {
            const db = getDb(this.runtime.rootDir)
            const fullJob = db.prepare("SELECT status, error_text, result_text FROM worker_jobs WHERE id = ?").get(task.id) as { status: string; error_text?: string; result_text?: string } | undefined
            if (fullJob && (fullJob.status === "completed" || fullJob.status === "failed" || fullJob.status === "killed")) {
              logger.warn(`[Worker Monitor] Discovered silently completed/failed job ${task.id} in SQLite. Proactively synchronizing and notifying parent.`)
              task.status = fullJob.status as any
              task.result = fullJob.result_text ?? ""
              task.error = fullJob.error_text ?? ""
              await this.notifyParent(task, task.error)
            }
          }
        } catch (dbErr) {
          logger.warn(`[Worker Monitor] Error checking DB state for worker ${task.id}:`, dbErr)
        }
      }
    }, 45000)
    this.monitorInterval.unref()
  }

  private stopMonitorLoop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval)
      this.monitorInterval = null
      logger.info("[Worker Monitor] Monitoring loop stopped (no active workers).")
    }
  }

  async spawnAgent(
    parentSessionId: string,
    profileId: string,
    task: string,
    description?: string,
    type: DelegationTask["type"] = "worker",
    options?: { isolation?: "none" | "worktree"; injected_context?: string },
  ): Promise<SpawnAgentResult> {
    return await this.spawnTask({
      parentSessionId,
      profileId,
      task,
      description,
      type,
      mode: "interactive",
      isolation: options?.isolation,
      injected_context: options?.injected_context,
    })
  }

  async spawnBackgroundTask(
    parentSessionId: string,
    profileId: string,
    task: string,
    description?: string,
    jobGroupId?: string,
    options?: { isolation?: "none" | "worktree"; injected_context?: string },
  ): Promise<SpawnAgentResult> {
    return await this.spawnTask({
      parentSessionId,
      profileId,
      task,
      description,
      type: "worker",
      mode: "background",
      jobGroupId,
      isolation: options?.isolation,
      injected_context: options?.injected_context,
    })
  }

  private async spawnTask(options: {
    parentSessionId: string
    profileId: string
    task: string
    description?: string
    type: DelegationTask["type"]
    mode: DelegationTask["mode"]
    jobGroupId?: string
    isolation?: "none" | "worktree"
    injected_context?: string
  }): Promise<SpawnAgentResult> {
    const rootDir = this.runtime.rootDir
    const subSessionId = `agent-${options.profileId}-${randomUUID().slice(0, 8)}`
    const traceId = createTraceparent()

    // Inherit adult mode state from parent session (propagate opt-out if parent disabled it)
    if (!this.runtime.hasAdultMode(options.parentSessionId)) {
      this.runtime.disableAdultMode(subSessionId)
    }

    const profiles = listProfiles(rootDir)
    if (!profiles.find(profile => profile.id === options.profileId)) {
      createProfile(rootDir, options.profileId, options.profileId, `Auto-generated profile for ${options.profileId}`)
    }
    ensureDirs(rootDir, options.profileId)
    
    // Inject project context if provided
    const projectContextBlock = options.injected_context
      ? [`\n<project-context>\n${options.injected_context.trim()}\n</project-context>\n`]
      : []

    // Append verified-tag requirement so the Ralph Loop can complete on first successful attempt
    const taskWithVerification = [
      options.task.trim(),
      ...projectContextBlock,
      "",
      WORKER_IMAGE_EXECUTION_POLICY,
      "",
      `When your task is fully done, end your final response with exactly: ${SUBAGENT_VERIFICATION_TAG}`,
    ].join("\n")
    
    const delegationTask: DelegationTask = {
      id: subSessionId,
      parentSessionId: options.parentSessionId,
      subSessionId,
      traceId,
      profileId: options.profileId,
      type: options.type,
      mode: options.mode,
      description: options.description || "Untitled task",
      task: options.task,
      injected_context: options.injected_context,
      status: "pending",
      jobGroupId: options.jobGroupId,
      logger: createInstanceLogger(subSessionId, options.type, traceId),
    }

    createWorkerSessionAndJob(rootDir, {
      sessionTitle: options.description || `Task: ${options.task.slice(0, 30)}...`,
      sessionId: subSessionId,
      profileId: options.profileId,
      job: {
        id: delegationTask.id,
        sessionId: delegationTask.parentSessionId,
        profileId: delegationTask.profileId,
        toolName: "background_worker",
        toolArgs: JSON.stringify({
          parentSessionId: delegationTask.parentSessionId,
          subSessionId: delegationTask.subSessionId,
          traceId: delegationTask.traceId,
          profileId: delegationTask.profileId,
          type: delegationTask.type,
          mode: delegationTask.mode,
          description: delegationTask.description,
          task: delegationTask.task,
          jobGroupId: delegationTask.jobGroupId,
        }),
        status: "pending",
      },
    })

    const bgTaskId = options.mode === "background"
      ? `bg-${randomUUID().slice(0, 12)}`
      : null

    if (options.isolation === "worktree") {
      const branchName = `monolito-worker-${randomUUID()}`
      delegationTask.cwd = await createAgentWorktree(rootDir, branchName)
    }

    if (bgTaskId) {
      createBackgroundTask(rootDir, {
        id: bgTaskId,
        sessionId: delegationTask.parentSessionId,
        taskPayload: JSON.stringify({
          task: delegationTask.task,
          description: delegationTask.description,
          type: delegationTask.type,
          cwd: delegationTask.cwd,
          traceId: delegationTask.traceId,
        }),
        agentId: delegationTask.id,
      })
      claimBackgroundTask(rootDir, bgTaskId, delegationTask.id)
    }

    if (this.runningWorkerCount >= MAX_CONCURRENT_WORKERS) {
      if (delegationTask.cwd) {
        await removeAgentWorktree(rootDir, delegationTask.cwd).catch(() => {})
      }
      updateWorkerJobStatus(rootDir, delegationTask.id, "failed", { errorText: `Concurrency limit reached (${MAX_CONCURRENT_WORKERS} workers running).` })
      return {
        agentId: "",
        status: "failed" as const,
        error: `Concurrency limit reached (${MAX_CONCURRENT_WORKERS} workers running). Retry when current workers finish.`,
      }
    }

    this.activeTasks.set(delegationTask.id, delegationTask)
    this.startMonitorLoop()

    const abortController = new AbortController()
    const softTimeoutTimer = setTimeout(() => {
      delegationTask.logger?.warn(`Soft timeout reached (${SUBAGENT_TIMEOUT_MS}ms) for task ${delegationTask.id}. Continuing but monitoring.`)
    }, SUBAGENT_TIMEOUT_MS).unref()

    const hardTimeoutTimer = setTimeout(() => {
      delegationTask.logger?.error(`Hard timeout reached (${SUBAGENT_HARD_TIMEOUT_MS}ms). Forcing task ${delegationTask.id} to stop.`)
      abortController.abort()
      this.stopAgent(delegationTask.id, `Hard timeout of ${SUBAGENT_HARD_TIMEOUT_MS}ms exceeded`).catch(() => {})
    }, SUBAGENT_HARD_TIMEOUT_MS).unref()

    const runPromise = this.executeTurn(delegationTask, taskWithVerification, abortController.signal).catch(err => {
      logger.error(`Delegation task ${delegationTask.id} failed:`, err)
    }).finally(() => {
      clearTimeout(softTimeoutTimer)
      clearTimeout(hardTimeoutTimer)
    })

    if (options.mode === "background") {
      return { agentId: delegationTask.id, status: "spawned" }
    }

    const settled = await Promise.race([
      runPromise.then(() => delegationTask.status),
      new Promise<null>(resolve => setTimeout(() => resolve(null), IMMEDIATE_AGENT_SETTLE_MS)),
    ])

    if (settled && settled !== "running" && settled !== "pending") {
      return {
        agentId: delegationTask.id,
        status: delegationTask.status === "completed" || delegationTask.status === "failed" || delegationTask.status === "killed"
          ? delegationTask.status
          : "spawned",
        result: delegationTask.result,
        error: delegationTask.error,
      }
    }

    return { agentId: delegationTask.id, status: "spawned" }
  }

  async sendMessageToAgent(agentId: string, message: string): Promise<void> {
    const task = this.activeTasks.get(agentId)
    if (!task) throw new Error(`Agent ${agentId} not found.`)
    if (task.status === "running" || task.status === "pending") {
      throw new Error(`Agent ${agentId} is still running. Wait for its <task-notification> before sending another message.`)
    }
    if (task.status === "killed") {
      throw new Error(`Agent ${agentId} was stopped and cannot receive more messages.`)
    }
    
    // Continue in background
    this.executeTurn(task, message, undefined).catch(err => {
      logger.error(`Continuing agent ${agentId} failed:`, err)
    })
  }

  async stopAgent(agentId: string, reason = "Agent was stopped by coordinator."): Promise<void> {
    const task = this.activeTasks.get(agentId)
    if (!task) return // Task already removed from activeTasks (completed or cleaned up)

    // Guard: do not kill a task that is already finishing or completed
    if (task.status === "completed" || task.status === "failed" || task.status === "killed") {
      task.logger?.warn(`stopAgent called on ${task.status} task ${agentId} — ignoring.`)
      return
    }

    this.runtime.abortSession(task.subSessionId)
    task.status = "killed"
    const partialEvidence = extractPartialImageEvidence(this.runtime.rootDir, task.subSessionId)
    if (partialEvidence) task.result = partialEvidence
    updateWorkerJobStatus(this.runtime.rootDir, task.id, "failed", { errorText: reason, resultText: task.result })
    await this.notifyParent(task, partialEvidence ? `${reason}\n\n${partialEvidence}` : reason)
  }

  private async executeTurn(task: DelegationTask, text: string, abortSignal?: AbortSignal) {
    const turnStartedAt = Date.now()
    task.status = "running"
    updateWorkerJobStatus(this.runtime.rootDir, task.id, "running")
    this.runningWorkerCount++
    const { runtime } = this
    try {
      let currentText = text
      let turn: any
      let attempt = 1
      const maxAttempts = 6
      let partialResult = ""

      while (attempt <= maxAttempts && task.status === "running") {
        if (abortSignal?.aborted) {
          throw new Error("Task aborted by supervisor")
        }
        appendMessage(runtime.rootDir, task.subSessionId, "user", currentText)
        turn = await runtime.runTurn(task.subSessionId, currentText, task.profileId, {
          logger: task.logger,
          cwd: task.cwd,
          traceId: task.traceId,
          maxTokens: SUBAGENT_TOKEN_BUDGET,
        })
        task.usage = task.usage || { total_tokens: 0, tool_uses: 0, duration_ms: 0 };
        task.usage.total_tokens += turn.usage?.totalTokens ?? 0;
        task.usage.duration_ms = Date.now() - turnStartedAt;


        if (turn.error) {
          partialResult = turn.finalText || partialResult
          if (attempt >= maxAttempts) {
            throw new Error(turn.error)
          }
          currentText = buildSubagentRetryPrompt(
            task.task,
            turn.error,
            partialResult,
          )
          attempt++
          continue
        }

        const session = getSession(runtime.rootDir, task.subSessionId)
        const lastMessage = session?.messages.at(-1)
        const assistantReply = lastMessage?.role === "assistant"
          ? lastMessage.text
          : typeof turn.finalText === "string"
            ? turn.finalText
            : ""

        if (!hasVerificationTag(assistantReply)) {
          appendWorklog(runtime.rootDir, task.subSessionId, {
            type: "note",
            summary: `[Ralph Loop] Blocked premature completion on attempt ${attempt}: missing ${SUBAGENT_VERIFICATION_TAG}`,
          })
          partialResult = assistantReply || partialResult
          if (attempt >= maxAttempts) {
            throw new Error(`[Ralph Loop] Agent exhausted ${maxAttempts} attempts without emitting ${SUBAGENT_VERIFICATION_TAG}`)
          }
          currentText = buildRalphLoopPrompt(task.task, assistantReply)
          attempt++
          continue
        }

        // 2. Cognitive Task Persistence (Memory Palace) check
        const activeTasksList = listSessionTasks(runtime.rootDir, task.subSessionId, task.profileId)
        const unfinishedTasks = activeTasksList.filter(t => t.status === "pending" || t.status === "in_progress")
        if (unfinishedTasks.length > 0) {
          appendWorklog(runtime.rootDir, task.subSessionId, {
            type: "note",
            summary: `[Ralph Loop] Blocked premature completion on attempt ${attempt}: ${unfinishedTasks.length} unfinished tasks remaining in Memory Palace.`,
          })
          partialResult = assistantReply || partialResult
          if (attempt >= maxAttempts) {
            throw new Error(`[Ralph Loop] Agent exhausted ${maxAttempts} attempts with unfinished cognitive tasks remaining`)
          }
          currentText = buildRalphLoopUnfinishedTasksPrompt(task.task, unfinishedTasks, assistantReply)
          attempt++
          continue
        }

        // 3. Failing Bash command exit code check
        const failingBash = getLatestFailingBashCommand(runtime.rootDir, task.subSessionId)
        if (failingBash) {
          appendWorklog(runtime.rootDir, task.subSessionId, {
            type: "note",
            summary: `[Ralph Loop] Blocked premature completion on attempt ${attempt}: Latest bash command '${failingBash.command}' failed with exitCode ${failingBash.exitCode}.`,
          })
          partialResult = assistantReply || partialResult
          if (attempt >= maxAttempts) {
            throw new Error(`[Ralph Loop] Agent exhausted ${maxAttempts} attempts with failing terminal command exitCode`)
          }
          currentText = buildRalphLoopFailingBashPrompt(task.task, failingBash.command, failingBash.exitCode ?? -1, assistantReply)
          attempt++
          continue
        }

        // 4. Image verification check
        if (isImageTaskIntent(task.task, task.description) && requiresImageVerification(task.task, task.description)) {
          if (!hasSuccessfulAnalyzeImage(session, runtime.rootDir, task.subSessionId)) {
            appendWorklog(runtime.rootDir, task.subSessionId, {
              type: "note",
              summary: `[Ralph Loop] Blocked premature completion on attempt ${attempt}: Image task must execute a vision tool (AnalyzeImage or VisionAnalyze) for verification.`,
            })
            partialResult = assistantReply || partialResult
            if (attempt >= maxAttempts) {
              throw new Error(`[Ralph Loop] Agent exhausted ${maxAttempts} attempts without executing a vision tool`)
            }
            currentText = buildRalphLoopImagePrompt(task.task, assistantReply)
            attempt++
            continue
          }
        }


        break
      }

      if (task.status !== "running") {
        return
      }

      task.status = "completed"
      task.result = turn.finalText
      task.error = undefined
      task.usage = {
        total_tokens: task.usage?.total_tokens ?? 0,
        tool_uses: task.usage?.tool_uses ?? 0,
        duration_ms: Date.now() - turnStartedAt,
      }
      updateWorkerJobStatus(this.runtime.rootDir, task.id, "completed", { resultText: task.result })
      // 3. Notify parent session with XML
      await this.notifyParent(task)

    } catch (error) {
      task.status = "failed"
      const errorMsg = error instanceof Error ? error.message : String(error)
      const partialEvidence = extractPartialImageEvidence(this.runtime.rootDir, task.subSessionId)
      task.error = errorMsg
      if (partialEvidence) task.result = partialEvidence
      updateWorkerJobStatus(this.runtime.rootDir, task.id, "failed", { errorText: errorMsg, resultText: task.result })
      await this.notifyParent(task, partialEvidence ? `${errorMsg}\n\n${partialEvidence}` : errorMsg)
    } finally {
      this.runningWorkerCount--
    }
  }

  private async notifyParent(task: DelegationTask, error?: string) {
    if (task.cwd) {
      const worktreePath = task.cwd
      task.cwd = undefined
      try {
        await removeAgentWorktree(this.runtime.rootDir, worktreePath)
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        task.logger?.warn(`Failed to remove agent worktree ${worktreePath}: ${message}`)
      }
    }

    // Schedule removal from activeTasks after retention window
    setTimeout(() => this.activeTasks.delete(task.id), TASK_RETENTION_MS)

    if (task.mode === "background") {
      const bgTasks = listBackgroundTasks(this.runtime.rootDir, task.parentSessionId, { status: "IN_PROGRESS" })
      const bgTask = bgTasks.find(t => t.agent_id === task.id)
      if (bgTask) {
        const diff = await this.captureTaskDiff(task)
        if (task.status === "completed") {
          updateBackgroundTaskStatus(this.runtime.rootDir, bgTask.id, "HANDOFF", {
            resultDiff: diff ?? task.result,
          })
        } else {
          updateBackgroundTaskStatus(this.runtime.rootDir, bgTask.id, "FAILED", {
            errorText: error ?? task.error,
            resultDiff: diff,
          })
        }
      }
      this.runtime.emit({
        type: "agent.background.completed",
        sessionId: task.parentSessionId,
        agentId: task.id,
        status: task.status === "completed" ? "completed" : task.status === "killed" ? "killed" : "failed",
        result: task.result,
        error,
      })
      void this.runtime.handleBackgroundDelegationResult(task, error).finally(() => {
        monolitoEvents.emit("worker:completed", {
          jobId: task.id,
          sessionId: task.parentSessionId,
          chatId: task.parentSessionId.startsWith("telegram-") ? task.parentSessionId.slice("telegram-".length) : undefined,
          status: task.status === "completed" ? "completed" : task.status === "killed" ? "killed" : "failed",
          result: task.result,
          error,
        })
      })
      return
    }

    const usageXml = task.usage ? `
<usage>
  <total_tokens>${task.usage.total_tokens}</total_tokens>
  <duration_ms>${task.usage.duration_ms}</duration_ms>
</usage>` : ""

    const notification = `<task-notification>
<task-id>${task.id}</task-id>
<status>${task.status}</status>
<summary>Agent "${task.description}" ${task.status}${error ? `: ${error}` : ""}</summary>
${task.result ? `<result>${task.result}</result>` : ""}
${usageXml}
</task-notification>`

    appendMessage(this.runtime.rootDir, task.parentSessionId, "user", notification)
    this.runtime.emit({
      type: "message.received",
      sessionId: task.parentSessionId,
      role: "user",
      text: notification
    })
    // Coordinator handles the response; no direct Telegram delivery needed here
  }

  recoverPersistedTasks(): number {
    let recovered = 0
    for (const job of listRecoverableWorkerJobs(this.runtime.rootDir)) {
      if (job.tool_name !== "background_worker") continue
      if (this.activeTasks.has(job.id)) continue
      let payload: Partial<DelegationTask>
      try {
        payload = JSON.parse(job.tool_args) as Partial<DelegationTask>
      } catch (error) {
        updateWorkerJobStatus(this.runtime.rootDir, job.id, "failed", {
          errorText: `Could not recover worker payload: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
      if (!payload.parentSessionId || !payload.subSessionId || !payload.profileId || !payload.task) {
        updateWorkerJobStatus(this.runtime.rootDir, job.id, "failed", { errorText: "Could not recover worker payload: missing required fields" })
        continue
      }
      const task: DelegationTask = {
        id: job.id,
        parentSessionId: payload.parentSessionId,
        subSessionId: payload.subSessionId,
        traceId: payload.traceId,
        profileId: payload.profileId,
        type: payload.type ?? "worker",
        mode: payload.mode ?? "background",
        description: payload.description ?? "Recovered worker",
        task: payload.task,
        status: "pending",
        jobGroupId: payload.jobGroupId,
        logger: createInstanceLogger(payload.subSessionId, payload.type ?? "worker", payload.traceId),
      }
      appendWorklog(this.runtime.rootDir, task.parentSessionId, {
        type: "note",
        summary: `Recovered worker ${task.id} after daemon restart with persisted status ${job.status}.`,
      })
      appendWorklog(this.runtime.rootDir, task.subSessionId, {
        type: "note",
        summary: `Recovered after daemon restart from persisted worker job ${task.id} with status ${job.status}.`,
      })
      this.activeTasks.set(task.id, task)
      const prompt = buildSubagentRetryPrompt(task.task, "Daemon restarted while this worker was pending or running.")
      this.executeTurn(task, prompt, undefined).catch(err => {
        logger.error(`Recovered delegation task ${task.id} failed:`, err)
      })
      recovered++
    }
    return recovered
  }

  listTasks() {
    return Array.from(this.activeTasks.values())
  }

  getTaskSnapshot(parentSessionId: string): TaskSnapshot[] {
    return Array.from(this.activeTasks.values())
      .filter(task => task.parentSessionId === parentSessionId)
      .map(task => ({
        agentId: task.id,
        description: task.description,
        status: task.status,
        hasResult: Boolean(task.result?.trim()),
        progress: getTaskProgress(this.runtime.rootDir, task.subSessionId, task.profileId),
        ...(task.error ? { error: task.error } : {}),
      }))
  }

  private async captureTaskDiff(task: DelegationTask): Promise<string | null> {
    if (!task.cwd) return null
    try {
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      const execAsync = promisify(execFile)
      const diff = await execAsync("git", ["diff", "--stat"], { cwd: task.cwd, timeout: 5000 })
      return diff.stdout.trim() || null
    } catch {
      return null
    }
  }
}
