import { randomUUID } from "node:crypto"
import { type MonolitoV2Runtime } from "./runtime.ts"
import { runBackgroundTextTask } from "./modelAdapter.ts"
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
  listRalphRules,
  isMainSession,
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
  "- Para verificar, validar, analizar o describir el contenido visual, debés utilizar prioritariamente la herramienta VisionAnalyze (en la nube).",
  "- Usá la herramienta local AnalyzeImage como fallback únicamente si VisionAnalyze no está disponible o falla.",
  "- Si la herramienta confirma que la imagen no coincide, descarta ese resultado y proba la siguiente `image_url` de la lista.",
  "- No crees perfiles, archivos de plan ni tareas auxiliares para buscar imagenes. Ejecuta el camino mas corto.",
].join("\n")

function normalizeForIntent(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
}

async function checkDynamicRalphRules(
  rootDir: string,
  sessionId: string,
  taskText: string,
  descriptionText: string,
  assistantReply: string,
  attempt: number
): Promise<string | null> {
  try {
    const rules = listRalphRules(rootDir)
    const combinedText = (taskText || "") + " " + (descriptionText || "")

    for (const row of rules) {
      try {
        const rule = JSON.parse(row.content) as {
          name: string
          intentRegex?: string
          requiredRegex?: string
          requiredTools: string[]
          errorMessage: string
        }

        if (!rule.requiredTools || !Array.isArray(rule.requiredTools) || rule.requiredTools.length === 0) {
          continue
        }

        // Semantic intent and requirements matching via LLM classification
        let isRuleApplicable = false
        try {
          const ruleDescriptionText = (rule as any).description || `Validates that the task executes at least one of these required tools: ${rule.requiredTools.join(", ")}`
          const systemPrompt = `You are a silent runtime auditor. Your task is to analyze if the user's instructions match the intent of the following auditing rule.
          
Auditing Rule: "${rule.name}"
Rule Description: "${ruleDescriptionText}"

CRITICAL:
- Do NOT match if the task only contains default system boilerplates, system-injected guidelines, or warnings. Only match if the user's actual requested objective aligns with the rule.
- If the rule applies to the user's core request, output true.

Respond strict JSON:
{
  "isApplicable": boolean,
  "reason": "brief explanation in English"
}`
          const userPrompt = `User task: "${combinedText}"`
          const { text } = await runBackgroundTextTask(rootDir, systemPrompt, userPrompt, { maxTokens: 100 })
          const parsed = JSON.parse(text.trim())
          isRuleApplicable = parsed.isApplicable === true
        } catch (llmErr) {
          // Fallback to regex if LLM is unavailable or fails
          const intentRe = rule.intentRegex ? new RegExp(rule.intentRegex, "i") : null
          const requiredRe = rule.requiredRegex ? new RegExp(rule.requiredRegex, "i") : null
          isRuleApplicable = (!intentRe || intentRe.test(combinedText)) && (!requiredRe || requiredRe.test(combinedText))
        }

        if (!isRuleApplicable) {
          continue
        }

        // Check for supreme user intent bypass/override of this specific rule (Level 0 Priority)
        // Generalist semantic LLM validation
        let hasBypassIntent = false
        const broadBypassRegex = /\b(sin|no|evitar|obviar|saltear|ignorar|skip|without|bypass|desactivar|omitir|force|forzar|no\s+hagas|don't|dont|avoid)\b/i
        if (broadBypassRegex.test(combinedText)) {
          try {
            const systemPrompt = `You are a silent runtime auditor. Your task is to analyze if the user's instructions explicitly request to bypass, skip, ignore, or perform a task WITHOUT using or running certain specific tools.
            
Required tools list: [${rule.requiredTools.join(", ")}]

Respond strict JSON:
{
  "explicitBypass": boolean,
  "reason": "brief explanation in English"
}`
            const userPrompt = `User instructions: "${combinedText}"`
            const { text } = await runBackgroundTextTask(rootDir, systemPrompt, userPrompt, {
              maxTokens: 100,
            })
            const parsed = JSON.parse(text.trim())
            if (parsed.explicitBypass === true) {
              hasBypassIntent = true
            }
          } catch (llmErr) {
            // Broad regex fallback if LLM is unavailable
            const bypassKeywords = ["sin", "no", "evitar", "obviar", "saltear", "ignorar", "skip", "without", "bypass"]
            hasBypassIntent = rule.requiredTools.some(tool => {
              const toolLower = tool.toLowerCase()
              const re = new RegExp(`\\b(${bypassKeywords.join("|")})\\b\\s*(?:a\\s+|la\\s+|las\\s+|los\\s+|mi\\s+|your\\s+|any\\s+|la\\s+tool\\s+|el\\s+tool\\s+|las\\s+tools\\s+|el\\s+uso\\s+de\\s+|la\\s+verificacion\\s+de\\s+)?\\b(${toolLower}|verif|valid|analiz|describ|confirm|vision|visual|real)`, "i")
              return re.test(combinedText)
            })
          }
        }

        if (hasBypassIntent) {
          logger.info(`[Ralph Loop] Bypassing rule '${rule.name || row.key}' due to explicit supreme user intent bypass: "${combinedText}"`)
          continue
        }

        // Rule is active: check if any of the required tools were executed successfully
        const events = tailEvents(rootDir, sessionId, 80)
        const hasSuccessfulTool = events.some(e =>
          e.type === "tool.finish" &&
          e.ok === true &&
          rule.requiredTools.includes(e.tool)
        )

        if (!hasSuccessfulTool) {
          appendWorklog(rootDir, sessionId, {
            type: "note",
            summary: `[Ralph Loop] Blocked premature completion on attempt ${attempt}: matched rule '${rule.name || row.key}' but did not successfully run required tools (${rule.requiredTools.join(", ")}).`,
          })

          return [
            taskText.trim(),
            "",
            rule.errorMessage || `Task verification failed for rule: ${rule.name || row.key}. Please execute one of: ${rule.requiredTools.join(", ")}`,
            "",
            `Último intento rechazado: ${clip(assistantReply, 500)}`,
          ].join("\n")
        }
      } catch (ruleErr) {
        logger.error(`Error parsing or evaluating dynamic Ralph rule ${row.key}: ${ruleErr}`)
      }
    }
  } catch (err) {
    logger.error(`Error listing dynamic Ralph rules: ${err}`)
  }

  return null
}

async function checkAssertionRalphRules(
  rootDir: string,
  sessionId: string,
  assistantReply: string,
  attempt: number
): Promise<string | null> {
  try {
    const events = tailEvents(rootDir, sessionId, 80)
    const normalizedReply = normalizeForIntent(assistantReply)

    // Fallback/default values using original regexes (Spanish specific)
    let send_telegram_photo = /(?:te (?:envié|mandé|pasé|subí|adjunté|compartí)|ahí te (?:va|van|mando|envío)|acá (?:tenés|tienen|está|están))\b/i.test(normalizedReply) &&
      /(?:foto|imagen|goma|teta|captura|pic|img)\b/i.test(normalizedReply)
    let send_telegram_file = /(?:te (?:envié|mandé|pasé|subí|adjunté|compartí)|ahí te (?:va|van|mando|envío)|acá (?:tenés|tienen|está|están))\b/i.test(normalizedReply) &&
      /(?:archivo|documento|pdf|zip|tar|rar|plan|txt)\b/i.test(normalizedReply)
    let send_telegram_msg = /(?:te (?:envié|mandé|pasé|escribí|avisé)|ahí te (?:mando|envío))\b/i.test(normalizedReply) &&
      /(?:mensaje|texto|chat|telegram)\b/i.test(normalizedReply)
    let modify_workspace_files = /(?:creé el archivo|guardé en|modifiqué el archivo|escribí en|actualicé el archivo|agregué al archivo|eliminé el archivo)\b/i.test(normalizedReply)
    let search_web = /(?:busqué en la web|busqué en internet|busqué en searxng|busqué en google|investigué en la web)\b/i.test(normalizedReply)

    // Language-agnostic semantic classification
    try {
      const systemPrompt = `You are a silent runtime auditor. Your task is to analyze the assistant's message to see if they claim to have completed certain types of actions in this turn.

Analyze the text and output a JSON object indicating whether the assistant explicitly or implicitly claims to have successfully done these actions:
1. "send_telegram_photo": True if they claim to have sent an image, photo, screenshot, visual asset, or media via Telegram.
2. "send_telegram_file": True if they claim to have sent a file, document, zip, pdf, sheet, or report via Telegram.
3. "send_telegram_msg": True if they claim to have sent a message, notification, ping, alert, or text update via Telegram.
4. "modify_workspace_files": True if they claim to have created, written, edited, modified, updated, or deleted any file in the workspace.
5. "search_web": True if they claim to have performed a web search, internet search, or fetched information from a web URL.

CRITICAL RULES:
- Language Agnostic: The text might be in Spanish, English, Portuguese, or any other language.
- Claims vs. Promises: Only flag if the assistant claims they HAVE ALREADY DONE/SENT it in this turn (e.g. "I've sent the photo", "ahí van las fotos", "aquí tienes el documento", "ya busqué en internet", "he editado el archivo"). Do NOT flag future promises (e.g., "I will send it later", "en un momento te lo envío").
- Be precise and strict. Only output true if the language clearly asserts the action was performed.

Respond ONLY with a valid JSON object in this format:
{
  "send_telegram_photo": boolean,
  "send_telegram_file": boolean,
  "send_telegram_msg": boolean,
  "modify_workspace_files": boolean,
  "search_web": boolean
}`

      const { text } = await runBackgroundTextTask(rootDir, systemPrompt, `Assistant message: "${assistantReply}"`, {
        maxTokens: 150,
      })

      const parsed = JSON.parse(text.trim())
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.send_telegram_photo === "boolean") send_telegram_photo = parsed.send_telegram_photo
        if (typeof parsed.send_telegram_file === "boolean") send_telegram_file = parsed.send_telegram_file
        if (typeof parsed.send_telegram_msg === "boolean") send_telegram_msg = parsed.send_telegram_msg
        if (typeof parsed.modify_workspace_files === "boolean") modify_workspace_files = parsed.modify_workspace_files
        if (typeof parsed.search_web === "boolean") search_web = parsed.search_web
        
        logger.debug(`[Ralph Loop] Semantic verification classification: ${JSON.stringify(parsed)}`)
      }
    } catch (llmErr) {
      logger.warn(`[Ralph Loop] Semantic verification LLM call failed, falling back to regex: ${llmErr}`)
    }

    // Rule 1: Telegram media delivery (photos/images/gomas/tetas)
    if (send_telegram_photo) {
      const sentPhoto = events.some(e =>
        e.type === "tool.finish" &&
        e.ok === true &&
        ["TelegramSendPhoto", "TelegramSendDocument"].includes(e.tool)
      )
      if (!sentPhoto) {
        appendWorklog(rootDir, sessionId, {
          type: "note",
          summary: `[Ralph Loop] Blocked premature completion on attempt ${attempt}: claimed to send photo/image, but TelegramSendPhoto/TelegramSendDocument did not run successfully.`,
        })
        return [
          "[Ralph Loop] SYSTEM ALERT",
          "Afirmaste en tu mensaje que enviaste una foto o imagen por Telegram, pero la herramienta 'TelegramSendPhoto' o 'TelegramSendDocument' no se ejecutó con éxito (o falló con algún error de ruta/API).",
          "Es obligatorio realizar el envío efectivo del archivo antes de dar por terminada la tarea.",
          "Por favor, revisá por qué falló el envío (ej: rutas duplicadas, imágenes no descargadas), corregí el error y realizá el envío por Telegram antes de responder.",
          "",
          `Último intento rechazado: ${clip(assistantReply, 500)}`,
        ].join("\n")
      }
    }

    // Rule 2: Telegram file delivery
    if (send_telegram_file) {
      const sentFile = events.some(e =>
        e.type === "tool.finish" &&
        e.ok === true &&
        ["TelegramSendDocument", "TelegramSendPhoto"].includes(e.tool)
      )
      if (!sentFile) {
        appendWorklog(rootDir, sessionId, {
          type: "note",
          summary: `[Ralph Loop] Blocked premature completion on attempt ${attempt}: claimed to send file/document, but TelegramSendDocument did not run successfully.`,
        })
        return [
          "[Ralph Loop] SYSTEM ALERT",
          "Afirmaste en tu mensaje que enviaste un archivo o documento por Telegram, pero la herramienta 'TelegramSendDocument' no se ejecutó con éxito.",
          "Es obligatorio realizar el envío efectivo del documento antes de dar por terminada la tarea.",
          "Por favor, ejecutá el envío por Telegram con la herramienta adecuada antes de responder.",
          "",
          `Último intento rechazado: ${clip(assistantReply, 500)}`,
        ].join("\n")
      }
    }

    // Rule 3: Telegram message delivery (fallback for general "te mandé un mensaje")
    if (send_telegram_msg) {
      const sentMsg = events.some(e =>
        e.type === "tool.finish" &&
        e.ok === true &&
        ["TelegramSend", "TelegramSendPhoto", "TelegramSendAudio", "TelegramSendVoice", "TelegramSendDocument"].includes(e.tool)
      )
      if (!sentMsg) {
        appendWorklog(rootDir, sessionId, {
          type: "note",
          summary: `[Ralph Loop] Blocked premature completion on attempt ${attempt}: claimed to send message/notify, but no TelegramSend* tools ran successfully.`,
        })
        return [
          "[Ralph Loop] SYSTEM ALERT",
          "Afirmaste en tu mensaje que enviaste un mensaje o notificación por Telegram, pero ninguna herramienta de envío de Telegram ('TelegramSend', 'TelegramSendPhoto', etc.) se ejecutó con éxito.",
          "Es obligatorio interactuar con el canal de Telegram si decís que lo hiciste.",
          "Por favor, ejecutá el envío por Telegram correspondiente antes de responder.",
          "",
          `Último intento rechazado: ${clip(assistantReply, 500)}`,
        ].join("\n")
      }
    }

    // Rule 4: File modification claims
    if (modify_workspace_files) {
      const modifiedFile = events.some(e =>
        e.type === "tool.finish" &&
        e.ok === true &&
        ["Write", "Edit", "MultiEdit", "replace_file_content", "multi_replace_file_content", "WriteFile", "EditFile", "Bash"].includes(e.tool)
      )
      if (!modifiedFile) {
        appendWorklog(rootDir, sessionId, {
          type: "note",
          summary: `[Ralph Loop] Blocked premature completion on attempt ${attempt}: claimed to modify files, but no writing/editing tool ran successfully.`,
        })
        return [
          "[Ralph Loop] SYSTEM ALERT",
          "Afirmaste en tu mensaje que creaste, modificaste o escribiste en un archivo, pero ninguna herramienta de escritura/edición ('Write', 'Edit', etc.) se ejecutó con éxito.",
          "No podés finalizar si decís que modificaste archivos en el workspace pero no realizaste la acción efectiva.",
          "Por favor, editá o escribí los archivos correspondientes en el workspace usando las herramientas antes de responder.",
          "",
          `Último intento rechazado: ${clip(assistantReply, 500)}`,
        ].join("\n")
      }
    }

    // Rule 5: Web Search claims
    if (search_web) {
      const searched = events.some(e =>
        e.type === "tool.finish" &&
        e.ok === true &&
        ["WebSearch", "WebFetch", "ImageSearch", "search_web"].includes(e.tool)
      )
      if (!searched) {
        appendWorklog(rootDir, sessionId, {
          type: "note",
          summary: `[Ralph Loop] Blocked premature completion on attempt ${attempt}: claimed to perform web search, but no search tool ran successfully.`,
        })
        return [
          "[Ralph Loop] SYSTEM ALERT",
          "Afirmaste en tu mensaje que realizaste una búsqueda en la web o internet, pero ninguna herramienta de búsqueda ('WebSearch', etc.) se ejecutó con éxito.",
          "Si afirmás que buscaste información en internet, debés haber llamado a una herramienta de búsqueda.",
          "Por favor, ejecutá la búsqueda web correspondiente antes de responder.",
          "",
          `Último intento rechazado: ${clip(assistantReply, 500)}`,
        ].join("\n")
      }
    }

  } catch (err) {
    logger.error(`Error executing assertion Ralph rules: ${err}`)
  }
  return null
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

function buildAttemptHistorySection(history: Array<{ attempt: number; kind: string; summary: string }>): string {
  if (history.length === 0) return ""
  const recent = history.slice(-3)
  return [
    "## PRIOR ATTEMPTS (do NOT repeat these approaches)",
    recent.map(h => `- [attempt ${h.attempt}] [${h.kind}] ${clip(h.summary, 200)}`).join("\n"),
    "",
  ].join("\n")
}

function buildSameErrorNudge(repeatCount: number): string {
  if (repeatCount < 2) return ""
  return [
    `## SAME-ERROR DETECTION`,
    `This is the ${repeatCount}-th consecutive attempt failing with the same error signature.`,
    "STOP and reconsider before retrying:",
    "1. Is the failing tool fundamentally unable to do what you need? (e.g. trying to use Bash to call an LLM API — use the right tool)",
    "2. Is your INPUT to the tool wrong? (wrong path, wrong arg, wrong syntax — re-read the tool schema and the error message carefully)",
    "3. Is the WORKSPACE state wrong? (missing file, stale state — check `ls`, `pwd`, recent `git status` before retrying)",
    "4. Is the APPROACH wrong? (e.g. you keep editing a file but the bug is in a different file — re-read the task carefully and trace the actual data flow)",
    "Try a SUBSTANTIALLY DIFFERENT approach. Do not retry the identical input — that is what got you here.",
    "",
  ].join("\n")
}

function buildEscapeHatchSection(attempt: number, escapeAt: number, history: Array<{ attempt: number; kind: string; summary: string }>): string {
  if (attempt < escapeAt) return ""
  const remaining = 20 - attempt
  const recent = history.slice(-5)
  return [
    `## ESCAPE HATCH (attempt ${attempt}/20, ${remaining} remaining)`,
    "You have iterated many times. Before the next attempt, you MUST surface the blocker with structure:",
    "1. WHAT YOU TRIED — list the approaches you actually attempted (not just rejected attempts)",
    "2. WHAT FAILED — for each, the specific failure mode (exit code, error message, missing data)",
    "3. WHAT YOU NEED — is it a tool you don't have? a permission? information only the user has? a structural issue in the codebase?",
    "4. WHY YOU CAN'T PROCEED — be honest. 'The task is impossible as specified' is a valid answer if it's true.",
    "",
    "You will have one more attempt after this. Make it count by either:",
    "(a) trying a fundamentally different approach informed by the above, OR",
    "(b) returning a structured failure with the data above so the orchestrator can re-delegate or surface to the user.",
    "",
    "Recent attempts:",
    recent.map(h => `- [${h.attempt}] ${h.kind}: ${clip(h.summary, 150)}`).join("\n"),
    "",
  ].join("\n")
}

function buildSubagentRetryPrompt(
  task: string,
  error: unknown,
  partialResult: string | undefined,
  history: Array<{ attempt: number; kind: string; summary: string }>,
  sameErrorRepeatCount: number,
  attempt: number,
  escapeAt: number,
): string {
  const message = error instanceof Error ? error.message : String(error)
  return [
    task.trim(),
    "",
    WORKER_IMAGE_EXECUTION_POLICY,
    "",
    `[Ralph Loop] ATTEMPT ${attempt}/20 — a tool execution failed.`,
    `Technical error: ${clip(message, 240)}`,
    "",
    "PERSISTENCE GUIDANCE (read before retrying):",
    "1. Read the error message carefully. The data is there. What specifically failed?",
    "2. Do NOT retry the identical input. If the same command with the same args failed once, it will fail again.",
    "3. Form a hypothesis about WHY it failed (missing file? wrong path? permissions? tool limitation?) and change the approach accordingly.",
    "4. If a different tool would be more appropriate, use that tool instead.",
    "5. If you can fix the underlying state and retry, do that.",
    "",
    buildSameErrorNudge(sameErrorRepeatCount),
    buildAttemptHistorySection(history),
    buildEscapeHatchSection(attempt, escapeAt, history),
    partialResult?.trim() ? `Partial result to keep: ${clip(partialResult, 500)}` : "",
  ].filter(Boolean).join("\n")
}

function hasVerificationTag(text: string | undefined) {
  return typeof text === "string" && text.trimEnd().endsWith(SUBAGENT_VERIFICATION_TAG)
}

/**
 * Compute a stable signature for an error so the orchestrator can detect
 * "same error N times in a row". The signature is (kind, normalizedDetail)
 * where kind is a coarse category and normalizedDetail is the error message
 * with volatile parts (paths, line numbers, exit codes that change between
 * attempts) stripped. Two errors that share the same kind+detail almost
 * certainly mean the agent is doing the same thing wrong repeatedly.
 */
function computeErrorSignature(error: unknown): { kind: string; detail: string } {
  const raw = error instanceof Error ? error.message : String(error)
  // Coarse category
  let kind = "unknown"
  if (/max iterations reached/i.test(raw)) kind = "max-iterations"
  else if (/turn duration exceeded/i.test(raw)) kind = "timeout"
  else if (/context overflow/i.test(raw)) kind = "context-overflow"
  else if (/auth|401|403/i.test(raw)) kind = "auth"
  else if (/rate.?limit|429/i.test(raw)) kind = "rate-limit"
  else if (/timeout|etimedout|aborted/i.test(raw)) kind = "timeout"
  else if (/permission|eacces|eperm/i.test(raw)) kind = "permission"
  else if (/not found|enoent/i.test(raw)) kind = "not-found"
  else if (/syntax|parse/i.test(raw)) kind = "syntax"
  // Strip volatile parts: numbers, hex ids, absolute paths
  const normalized = raw
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\/[^\s]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
  return { kind, detail: normalized }
}

function buildRalphLoopPrompt(
  task: string,
  assistantReply: string,
  history: Array<{ attempt: number; kind: string; summary: string }>,
  attempt: number,
  escapeAt: number,
): string {
  return [
    task.trim(),
    "",
    `[Ralph Loop] ATTEMPT ${attempt}/20 — you tried to finalize without the required verification tag.`,
    "",
    "Why this is not a workaround for the verification tag:",
    `- The tag (${SUBAGENT_VERIFICATION_TAG}) is the runtime's way to know that the work has actually been performed with real tool evidence.`,
    "- Emitting it without doing the work creates a no-op success claim that the Coherence Guard and the veracity checks will catch downstream.",
    "- The tag is reserved for genuine completion. A task you cannot complete should return a structured failure instead of a fake success.",
    "",
    "To satisfy the tag legitimately, you need to demonstrate (with real tool calls) that the work was done. Possible paths:",
    "1. Actually execute the missing tool calls and re-emit the tag once they succeed.",
    "2. If the task doesn't require tool execution, return a STRUCTURED FAILURE (TASK_FAILED:<reason>) explaining why instead of the success tag.",
    "3. If a sub-agent, report TASK_FAILED:INSUFFICIENT_TOOLS — the orchestrator will re-delegate with the right toolset.",
    "",
    buildAttemptHistorySection(history),
    buildEscapeHatchSection(attempt, escapeAt, history),
    "Your last rejected response (DO NOT repeat the same response, even with a different preamble):",
    clip(assistantReply, 500),
  ].filter(Boolean).join("\n")
}


export function buildRalphLoopUnfinishedTasksPrompt(
  task: string,
  unfinished: Array<{ content: string; status: string }>,
  assistantReply: string,
  history: Array<{ attempt: number; kind: string; summary: string }>,
  attempt: number,
  escapeAt: number,
): string {
  const listStr = unfinished.map(t => `- [${t.status.toUpperCase()}] ${t.content}`).join("\n")
  return [
    task.trim(),
    "",
    `[Ralph Loop] ATTEMPT ${attempt}/20 — you tried to finalize while the cognitive task list has pending or in-progress items.`,
    "",
    "The task list is the orchestrator's source of truth for what you committed to do. Closing the turn while items remain in_progress means you're claiming success on incomplete work.",
    "",
    "Items still open:",
    listStr,
    "",
    "To close the loop, you have two valid paths:",
    "1. COMPLETE THE WORK: for each pending item, actually do the work, then call TodoWrite with the full updated list marking them as completed. The verification tag is required ONLY when the work is genuinely done.",
    "2. RESTRUCTURE: if the work breakdown was wrong, call TodoWrite with a corrected list (add blockers as new in_progress items, mark abandoned items as completed with a note in activeForm explaining why, etc.).",
    "3. STRUCTURED FAILURE: if the work cannot be completed, return TASK_FAILED:<reason> instead of the success tag.",
    "",
    "Do NOT mark items as completed without doing the work. The Coherence Guard treats that as INCOHERENT.",
    "",
    buildAttemptHistorySection(history),
    buildEscapeHatchSection(attempt, escapeAt, history),
    "Your last rejected response (DO NOT repeat the same response):",
    clip(assistantReply, 500),
  ].filter(Boolean).join("\n")
}

// =============================================================================
// Top-level Ralph gate (Stop-hook analog for the orchestrator session)
// =============================================================================
//
// Bug it fixes: the top-level (orchestrator) session registers TodoWrite
// items, the model runs a few of them, leaves the rest pending, and tries
// to close the turn. The runtime previously delivered the reply without
// checking the task list. The sub-agent path already had this check
// (buildRalphLoopUnfinishedTasksPrompt inside executeTurn); the top-level
// path did not.
//
// Approach mirrors Claude Code's Ralph Wiggum Stop hook: a runtime-level
// guard that reads external state (the Memory Palace `active_tasks` table),
// and — if the task list is not clean — re-feeds a structured retry prompt
// back to the model instead of delivering. The model can satisfy the gate
// by calling TodoWrite to mark the items completed, by restructuring, or
// by returning TASK_FAILED:<reason>.
// =============================================================================

export type TopLevelRalphGateResult = {
  /** True when the gate has unfinished items and the loop must continue. */
  blocked: boolean
  /** Convenience alias matching the runtime loop's vocabulary. */
  shouldRetry: boolean
  /** Feedback prompt to re-feed as a user message. Null when clean. */
  feedbackPrompt: string | null
  /** The unfinished items that triggered the block. */
  unfinished: Array<{ content: string; status: string }>
}

export const TOP_LEVEL_RALPH_MAX_ATTEMPTS = 20
export const TOP_LEVEL_RALPH_ESCAPE_AT = 15

/**
 * Evaluate the top-level Ralph gate for a session. Pure function (modulo
 * the SQLite read); safe to unit-test. The caller is responsible for the
 * loop, the worklog appends, and the actual re-feed via appendMessage +
 * re-running the agent loop.
 */
export function evaluateTopLevelRalphGate(
  rootDir: string,
  sessionId: string,
  profileId: string,
  lastUserText: string,
  attempt: number,
  assistantReply: string,
  history: Array<{ attempt: number; kind: string; summary: string }> = [],
): TopLevelRalphGateResult {
  const tasks = listSessionTasks(rootDir, sessionId, profileId)
  const unfinished = tasks
    .filter(t => t.status === "pending" || t.status === "in_progress")
    .map(t => ({ content: t.content, status: t.status }))

  if (unfinished.length === 0) {
    return { blocked: false, shouldRetry: false, feedbackPrompt: null, unfinished: [] }
  }

  const feedbackPrompt = buildRalphLoopUnfinishedTasksPrompt(
    lastUserText,
    unfinished,
    assistantReply,
    history,
    attempt,
    TOP_LEVEL_RALPH_ESCAPE_AT,
  )
  return { blocked: true, shouldRetry: true, feedbackPrompt, unfinished }
}

// =============================================================================
// Auto-delegate gate
// =============================================================================
//
// Goal: keep the user-facing main session from being eaten by multi-step
// shell work. The system prompt instructs the model to delegate with
// TodoWrite / AgentSpawn when a task has 3+ steps, but the model often
// ignores that and starts running Bash directly. This gate observes the
// stream of tool calls in the current turn and, once it sees the model
// going down a Bash-heavy path WITHOUT first planning (TodoWrite) or
// delegating (AgentSpawn / delegate_background_task), recommends that
// the runtime auto-delegate the work to a sub-agent.
//
// This is the runtime-level analog of the user-facing rule "the main
// session is for the user; heavy work goes to sub-agents." The model
// never sees a warning — the runtime just takes over and spawns a
// background worker that finishes the job (or fails with structured
// evidence) and wakes the main session up when done.
// =============================================================================

/** Tools that count as "the model is planning" or "the model delegated". */
export const PLANNING_TOOLS = new Set([
  "TodoWrite",
  "TodoList",
  "TodoUpdate",
  "AgentSpawn",
  "AgentList",
  "AgentSendMessage",
  "AgentStop",
  "delegate_background_task",
  "TriggerBackgroundStudy",
])

/** Tools that are cheap, side-effect free, or pure reads — not Bash-heavy. */
export const LIGHT_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "list_files",
  "pwd",
  "WebFetch",
  "WebSearch",
  "ImageSearch",
  "AnalyzeImage",
  "VisionAnalyze",
  "TodoList",
  "BootRead",
  "BootListWings",
  "WorkspaceMemoryRecall",
  "KgQuery",
  "QuerySessionStatus",
  "QueryCost",
  "QuerySessionStats",
  "CompactSession",
  "SessionForensics",
  "list_active_workers",
  "ListSkills",
  "skill_view",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
])

export type DelegateGateResult = {
  /** True when the runtime should auto-delegate the work. */
  shouldDelegate: boolean
  /** Bash tool count in the current turn at evaluation time. */
  bashCount: number
  /** Whether the model already called a planning/delegation tool. */
  planningToolUsed: boolean
  /** Human-readable reason (for worklog). */
  reason: string
}

/**
 * Pure function. Given the list of tool names already executed (or
 * currently executing) in the current turn, decide whether the runtime
 * should refuse the current tool and auto-delegate to a sub-agent.
 *
 * Trigger conditions (any of):
 *  - >= 2 Bash calls without a planning tool used first, OR
 *  - >= 1 Bash call AFTER a heavy call (>= 3 prior non-light calls)
 *    without a planning tool used first.
 *
 * If a planning tool has been used (TodoWrite, AgentSpawn, etc.) the
 * gate is silent — the model is following the rules.
 */
export function checkDelegateThreshold(
  toolNamesExecuted: ReadonlyArray<string>,
  currentToolName: string,
  options?: { bashThreshold?: number },
): DelegateGateResult {
  const bashThreshold = options?.bashThreshold ?? 2
  const planningToolUsed = toolNamesExecuted.some(t => PLANNING_TOOLS.has(t))
  const bashCount = toolNamesExecuted.filter(t => t === "Bash" || t === currentToolName).length

  if (planningToolUsed) {
    return {
      shouldDelegate: false,
      bashCount,
      planningToolUsed: true,
      reason: "Planning/delegation tool already used in this turn",
    }
  }

  if (currentToolName !== "Bash") {
    return {
      shouldDelegate: false,
      bashCount,
      planningToolUsed: false,
      reason: "Current tool is not Bash; gate only fires on Bash",
    }
  }

  if (bashCount >= bashThreshold) {
    return {
      shouldDelegate: true,
      bashCount,
      planningToolUsed: false,
      reason: `Detected ${bashCount} Bash calls in this turn without TodoWrite/AgentSpawn — the model is doing multi-step shell work in the main session.`,
    }
  }

  return {
    shouldDelegate: false,
    bashCount,
    planningToolUsed: false,
    reason: `Bash count ${bashCount} below threshold ${bashThreshold}`,
  }
}

function buildRalphLoopFailingBashPrompt(
  task: string,
  command: string,
  exitCode: number,
  assistantReply: string,
  history: Array<{ attempt: number; kind: string; summary: string }>,
  attempt: number,
  escapeAt: number,
): string {
  return [
    task.trim(),
    "",
    `[Ralph Loop] ATTEMPT ${attempt}/20 — you tried to finalize but the last verification command failed.`,
    `Comando: ${command}`,
    `Código de salida: ${exitCode}`,
    "",
    "A non-zero exit code on a verification command (tests, build, lint) means the work is NOT done. The Coherence Guard and the no-op detection would catch any 'looks done' claim that ignores the failure.",
    "",
    "To proceed:",
    "1. Read the error output above. It tells you what went wrong.",
    "2. Fix the underlying issue in the workspace.",
    "3. Re-run the verification command. Do not declare success until exit code 0.",
    "4. If the verification command is fundamentally broken (e.g. wrong binary path, missing dependency), switch to a different verification method (run a different test, ask the user to run it manually, etc.).",
    "",
    "If the verification genuinely cannot be run on this machine, document that in the structured failure response instead of marking the work complete.",
    "",
    buildAttemptHistorySection(history),
    buildEscapeHatchSection(attempt, escapeAt, history),
    "Your last rejected response:",
    clip(assistantReply, 500),
  ].filter(Boolean).join("\n")
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
  branchName?: string
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
      try {
        const { createCheckpointCommit } = await import("../context/gitContext.ts")
        await createCheckpointCommit(rootDir)
      } catch (err) {
        logger.warn(`Failed to create checkpoint commit: ${err}`)
      }
      const branchName = `monolito-worker-${randomUUID().slice(0, 8)}`
      delegationTask.cwd = await createAgentWorktree(rootDir, branchName)
      delegationTask.branchName = branchName
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
        if (delegationTask.branchName) {
          try {
            const { execFile } = await import("node:child_process")
            const { promisify } = await import("node:util")
            const execAsync = promisify(execFile)
            await execAsync("git", ["branch", "-D", delegationTask.branchName], { cwd: rootDir })
          } catch {}
        }
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
      // 20 attempts gives genuine iteration room. The escape hatch at 15
      // forces the agent to surface what's blocking instead of looping
      // indefinitely. 6 was too tight for real problems (a single wrong
      // API call + retry-with-fallback = 3-4 attempts minimum).
      const maxAttempts = 20
      const escapeHatchAttempt = 15
      let partialResult = ""
      // Track the last failure signature to detect "same error 2x in a row"
      // (key behavior: the system rejects repeating the identical failure
      // and forces the agent to try a different angle).
      let lastFailureSignature: { kind: string; detail: string } | null = null
      let sameErrorRepeatCount = 0
      // Track prior attempt summaries to feed the agent's "what was tried
      // before" awareness on re-prompts.
      const attemptHistory: Array<{ attempt: number; kind: string; summary: string }> = []

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
          const isExhausted = turn.error.includes("Max iterations reached") ||
                              turn.error.includes("Turn duration exceeded");
          if (attempt >= maxAttempts || isExhausted) {
            throw new Error(turn.error)
          }
          // Same-error detection: compute a stable signature for this error
          // and compare to the last one we saw. If 2+ consecutive failures
          // share the same signature, the next re-prompt will include a
          // nudge forcing the agent to try a substantially different approach.
          const sig = computeErrorSignature(turn.error)
          if (lastFailureSignature && lastFailureSignature.kind === sig.kind && lastFailureSignature.detail === sig.detail) {
            sameErrorRepeatCount++
          } else {
            sameErrorRepeatCount = 0
          }
          lastFailureSignature = sig
          appendWorklog(runtime.rootDir, task.subSessionId, {
            type: "note",
            summary: `[Ralph Loop] attempt ${attempt}/${maxAttempts} failed: ${sig.kind} — ${clip(sig.detail, 200)}.${sameErrorRepeatCount > 0 ? ` Same error repeated ${sameErrorRepeatCount} time(s).` : ""}`,
          })
          attemptHistory.push({ attempt, kind: sig.kind, summary: clip(sig.detail, 200) })
          currentText = buildSubagentRetryPrompt(
            task.task,
            turn.error,
            partialResult,
            attemptHistory,
            sameErrorRepeatCount,
            attempt + 1,
            escapeHatchAttempt,
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
          attemptHistory.push({ attempt, kind: "missing-verification-tag", summary: clip(assistantReply, 200) })
          currentText = buildRalphLoopPrompt(task.task, assistantReply, attemptHistory, attempt + 1, escapeHatchAttempt)
          attempt++
          continue
        }

        // Verified-tag cap: track how many times the tag has been emitted in
        // this session. If we've already seen the tag emitted MAX_VERIFIED_TAGS
        // times in prior assistant messages, the next emission is suspicious
        // (agent is just re-stamping SUCCESS without doing new work). Force
        // a terminal failure and snapshot the session for forensic review.
        const MAX_VERIFIED_TAGS_PER_SESSION = 2
        if (session) {
          const priorVerifiedCount = session.messages.filter(
            (m: { role: string; text: string }) =>
              m.role === "assistant" &&
              typeof m.text === "string" &&
              hasVerificationTag(m.text),
          ).length
          if (priorVerifiedCount >= MAX_VERIFIED_TAGS_PER_SESSION) {
            appendWorklog(runtime.rootDir, task.subSessionId, {
              type: "note",
              summary: `[Ralph Loop] Verified-tag cap reached: ${priorVerifiedCount} prior emissions in this session. Agent is re-stamping <verified>SUCCESS</verified> without new work. Forcing terminal failure.`,
            })
            throw new Error(`[Ralph Loop] Verified-tag cap (${MAX_VERIFIED_TAGS_PER_SESSION}) reached in session. Agent emitted the verification tag ${priorVerifiedCount} times without new tool execution evidence. Emergency snapshot required.`)
          }
        }

        // No-op detection: a worker that emits the verification tag without
        // ANY successful tool.finish event in the current turn is claiming
        // success on work that did not happen. This is structural (no
        // language dependency — the verification tag is the agent's own
        // protocol). Reject the success claim and force a real execution.
        const recentEvents = tailEvents(runtime.rootDir, task.subSessionId, 40)
        const hasSuccessfulToolInTurn = recentEvents.some(
          (e: { type: string; ok?: boolean }) => e.type === "tool.finish" && e.ok === true,
        )
        if (!hasSuccessfulToolInTurn) {
          appendWorklog(runtime.rootDir, task.subSessionId, {
            type: "note",
            summary: `[Ralph Loop] Blocked premature completion on attempt ${attempt}: worker emitted verification tag without any successful tool execution in this turn (no-op success claim).`,
          })
          partialResult = assistantReply || partialResult
          if (attempt >= maxAttempts) {
            throw new Error(`[Ralph Loop] Agent exhausted ${maxAttempts} attempts claiming success without executing any tool.`)
          }
          currentText = [
            task.task.trim(),
            "",
            "[Ralph Loop] NO-OP SUCCESS REJECTED",
            "Your final response included the verification tag but NO tool was actually executed successfully in this turn. The tag is reserved for work that has been empirically performed. Either:",
            "1. Execute the required tool(s) now and produce real evidence (file paths, command output, tool results), then re-emit the tag.",
            "2. If the task does not require tool execution, do NOT emit the tag — return a structured response explaining the limitation and what tool you would need.",
            `Technical error: claimed success on attempt ${attempt} with zero successful tool.finish events.`,
          ].join("\n")
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
          attemptHistory.push({ attempt, kind: "unfinished-cognitive-tasks", summary: `${unfinishedTasks.length} pending` })
          currentText = buildRalphLoopUnfinishedTasksPrompt(task.task, unfinishedTasks, assistantReply, attemptHistory, attempt + 1, escapeHatchAttempt)
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
          currentText = buildRalphLoopFailingBashPrompt(task.task, failingBash.command, failingBash.exitCode ?? -1, assistantReply, attemptHistory, attempt + 1, escapeHatchAttempt)
          attempt++
          continue
        }

        // 4. Dynamic Verification Rules check (SQLite Memory Palace backed)
        const dynamicBlockedPrompt = await checkDynamicRalphRules(runtime.rootDir, task.subSessionId, task.task, task.description || "", assistantReply, attempt)
        if (dynamicBlockedPrompt) {
          partialResult = assistantReply || partialResult
          if (attempt >= maxAttempts) {
            throw new Error(`[Ralph Loop] Agent exhausted ${maxAttempts} attempts with failing dynamic verification rules`)
          }
          currentText = dynamicBlockedPrompt
          attempt++
          continue
        }

        // 5. Assertion-based verification check (checks assistant claims vs actual tool executions)
        const assertionBlockedPrompt = await checkAssertionRalphRules(runtime.rootDir, task.subSessionId, assistantReply, attempt)
        if (assertionBlockedPrompt) {
          partialResult = assistantReply || partialResult
          if (attempt >= maxAttempts) {
            throw new Error(`[Ralph Loop] Agent exhausted ${maxAttempts} attempts with failing assertion verification rules`)
          }
          currentText = assertionBlockedPrompt
          attempt++
          continue
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
      const branchName = task.branchName
      task.cwd = undefined
      task.branchName = undefined
      
      try {
        if (task.status === "completed" && branchName) {
          try {
            const { commitWorktreeChanges, mergeBranchIntoRoot } = await import("../context/gitContext.ts")
            await commitWorktreeChanges(worktreePath, `feat: completed task ${task.id} in worktree`)
            await mergeBranchIntoRoot(this.runtime.rootDir, branchName)
            task.logger?.info(`Successfully committed worktree changes and merged branch ${branchName} into root repository.`)
            
            // If it belongs to a jobGroupId, abort any running sibling workers
            if (task.jobGroupId) {
              for (const sibling of Array.from(this.activeTasks.values())) {
                if (sibling.jobGroupId === task.jobGroupId && sibling.id !== task.id) {
                  if (sibling.status === "running" || sibling.status === "pending") {
                    task.logger?.info(`Cancelling sibling worker ${sibling.id} from group ${task.jobGroupId} (won by ${task.id}).`)
                    this.stopAgent(sibling.id, `Sibling worker ${task.id} won the multiverse race`).catch(err => {
                      task.logger?.warn(`Failed to stop sibling worker ${sibling.id}: ${err}`)
                    })
                  }
                }
              }
            }
          } catch (gitErr) {
            task.logger?.error(`Failed to commit/merge worktree changes: ${gitErr}`)
          }
        }

        await removeAgentWorktree(this.runtime.rootDir, worktreePath)

        if (branchName) {
          try {
            const { execFile } = await import("node:child_process")
            const { promisify } = await import("node:util")
            const execAsync = promisify(execFile)
            const deleteFlag = task.status === "completed" ? "-d" : "-D"
            await execAsync("git", ["branch", deleteFlag, branchName], { cwd: this.runtime.rootDir })
          } catch {}
        }
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

    const directive = isMainSession(task.parentSessionId)
      ? `\n\n[SYSTEM DIRECTIVE]\nA background worker task has completed. Retrieve the <result> above, translate it to your normal assistant voice, and deliver a direct update/response to the user now answering their immediate query. Do not mention XML tags, agent-ids, or background workers. Keep the execution details private.`
      : `\n\n[SYSTEM DIRECTIVE]\nA sub-agent task has completed. Convert this completion into a concise internal orchestration update for your parent agent in your own words. Do not mention XML tags or system/log details.`

    const notification = `<task-notification>
<task-id>${task.id}</task-id>
<status>${task.status}</status>
<summary>Agent "${task.description}" ${task.status}${error ? `: ${error}` : ""}</summary>
${task.result ? `<result>${task.result}</result>` : ""}
${usageXml}
</task-notification>${directive}`

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
      const prompt = buildSubagentRetryPrompt(
        task.task,
        "Daemon restarted while this worker was pending or running.",
        undefined,
        [],
        0,
        1,
        15,
      )
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
