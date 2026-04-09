import { execFile } from "node:child_process"
import { statSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { type AgentEvent, type SessionRecord } from "../ipc/protocol.ts"
import { StdioMcpClient, getDefaultMcpServers } from "../mcp/client.ts"
import {
  appendEvent,
  appendMessage,
  appendWorklog,
  compactSession,
  ensureSession,
  getSession,
  getSessionStats,
  listSessions,
  recoverRunningSessions,
  resetSession,
  setSessionState,
  tailEvents,
  updateSessionProfile,
  listProfiles,
  createProfile,
} from "../session/store.ts"
import { getTool, listTools } from "../tools/registry.ts"
import { getEffectiveModelConfig, runAssistantTurn } from "./modelAdapter.ts"
import {
  MODEL_PROTOCOL,
  applyModelSettingsToEnv,
  draftToSettings,
  loadAndApplyModelSettings,
  maskApiKey,
  readModelSettings,
  redactSensitiveModelSettings,
  saveModelSettings,
  settingsToDraft,
  validateModelDraft,
} from "./modelConfig.ts"
import { createCostState, recordApiCall, recordToolCall, formatCostSummary } from "../cost/tracker.ts"
import { readChannelsConfig } from "../channels/config.ts"
import { readWebSearchConfig } from "../websearch/config.ts"
import { getDateContext, getGitContext } from "../context/gitContext.ts"
import { getWorkspaceContext } from "../context/workspaceContext.ts"
import { AgentOrchestrator } from "./orchestrator.ts"
import { renderToolFinish, renderToolStart, renderToolStartText } from "../renderer/toolRenderer.ts"
import { checkToolPermission, runPostToolHooks } from "./permissions.ts"
import { runMemoryAgentReview } from "./memoryAgent.ts"

type EventListener = (event: AgentEvent) => void

type SessionBusyError = Error & {
  code: "SESSION_BUSY"
}

type ToolExecutionError = Error & {
  output?: unknown
}

type TelegramTypingIndicator = {
  stop(): void
}

const execFileAsync = promisify(execFile)

function createSessionBusyError(sessionId: string): SessionBusyError {
  const error = new Error(`Session ${sessionId} is already busy with another running turn.`) as SessionBusyError
  error.code = "SESSION_BUSY"
  return error
}

function createToolExecutionError(message: string, output: unknown): ToolExecutionError {
  const error = new Error(message) as ToolExecutionError
  error.output = output
  return error
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function truncateFailureDetail(value: string, max = 240) {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1).trimEnd()}...`
}

function getToolFailureMessage(toolName: string, output: unknown) {
  if (toolName !== "Bash") return null
  const value = asRecord(output)
  if (!value) return null
  const exitCode = typeof value.exitCode === "number" ? value.exitCode : null
  const stderr = typeof value.stderr === "string" ? value.stderr : ""
  if (exitCode !== null && exitCode !== 0) {
    return `Command exited ${exitCode}${stderr.trim() ? `: ${truncateFailureDetail(stderr)}` : ""}`
  }
  if (/(sudo:|se requiere una contraseña|a terminal is required|operaci[oó]n no permitida|operation not permitted|permission denied|kill:.*failed)/i.test(stderr)) {
    return `Command reported a permission/error condition: ${truncateFailureDetail(stderr)}`
  }
  return null
}

function outputWithError(output: unknown, message: string) {
  const value = asRecord(output)
  return value ? { ...value, error: message } : { error: message }
}

function buildResidualUpdateError(rootDir: string, stashLabel: string, statusAfterStash: string) {
  const rootName = rootDir.split("/").filter(Boolean).at(-1) ?? "repo"
  const lines = [
    "Update failed: the working tree still has local changes after the automatic backup step.",
    `Saved backup stash: ${stashLabel}`,
    "",
    "Remaining paths:",
    statusAfterStash,
  ]

  if (statusAfterStash.includes(`?? ${rootName}/`)) {
    lines.push(
      "",
      `Detected a nested clone or duplicate project directory inside the repo: ${rootName}/`,
      `Move or remove ${rootName}/${rootName} if it exists, then run /update again.`,
    )
  }

  return lines.join("\n")
}

async function runGitCommand(rootDir: string, args: string[]) {
  const result = await execFileAsync("git", args, {
    cwd: rootDir,
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  return result.stdout.trim()
}

function getTelegramChatId(sessionId: string) {
  return sessionId.startsWith("telegram-") ? sessionId.slice("telegram-".length) : null
}

function sanitizeExternalAssistantText(sessionId: string, text: string) {
  if (!getTelegramChatId(sessionId)) return text
  const normalized = text.trim()

  if (/^Model request failed:/i.test(normalized) || /^Network\/model error after retries:/i.test(normalized)) {
    return "Tengo un problema tecnico temporal con el proveedor del modelo. Proba de nuevo en unos segundos."
  }

  if (/^Model request failed after retries$/i.test(normalized)) {
    return "No pude completar la respuesta por un problema temporal del modelo. Proba de nuevo en unos segundos."
  }

  return text
}

const TELEGRAM_MESSAGE_LIMIT = 4096

function chunkTelegramMessage(text: string, maxLength = TELEGRAM_MESSAGE_LIMIT) {
  const normalized = text.replace(/\r\n/g, "\n")
  if (normalized.length <= maxLength) return [normalized]

  const chunks: string[] = []
  let remaining = normalized
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength)
    const splitAt = Math.max(
      candidate.lastIndexOf("\n\n"),
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(" "),
    )
    const boundary = splitAt > maxLength * 0.5 ? splitAt : maxLength
    chunks.push(remaining.slice(0, boundary).trim())
    remaining = remaining.slice(boundary).trimStart()
  }
  if (remaining.trim()) chunks.push(remaining.trim())
  return chunks.filter(Boolean)
}

async function sendTelegramMessage(token: string, chatId: string, text: string) {
  for (const chunk of chunkTelegramMessage(text)) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    })
  }
}

async function sendTelegramTypingAction(token: string, chatId: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    })
  } catch {
    // Typing indicators are best-effort; message processing must not depend on them.
  }
}

function startTelegramTypingIndicator(sessionId: string): TelegramTypingIndicator | null {
  const chatId = getTelegramChatId(sessionId)
  if (!chatId) return null
  const config = readChannelsConfig()
  if (!config.telegram?.enabled || !config.telegram.token) return null
  const token = config.telegram.token

  void sendTelegramTypingAction(token, chatId)
  const interval = setInterval(() => {
    void sendTelegramTypingAction(token, chatId)
  }, 4_000)
  return {
    stop() {
      clearInterval(interval)
    },
  }
}

export class MonolitoV2Runtime {
  readonly rootDir: string
  private listeners = new Set<EventListener>()
  private mcpClients = new Map<string, StdioMcpClient>()
  private activeSessions = new Set<string>()
  private recentResumeAt = new Map<string, number>()
  private abortControllers = new Map<string, AbortController>()
  private costState = createCostState()
  private adultModeSessions = new Set<string>()
  private restartRequested = false
  readonly orchestrator: AgentOrchestrator

  constructor(rootDir: string) {
    this.rootDir = rootDir
    this.orchestrator = new AgentOrchestrator(this)
    loadAndApplyModelSettings(process.env)
  }

  onEvent(callback: EventListener) {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  ensureSession(sessionId?: string, title?: string, profileId = "default") {
    const existing = sessionId ? getSession(this.rootDir, sessionId) : null
    const session = ensureSession(this.rootDir, sessionId, title)
    
    // Ensure the profile exists in DB
    const profiles = listProfiles(this.rootDir)
    if (!profiles.find(p => p.id === profileId)) {
      createProfile(this.rootDir, profileId, profileId, `Auto-generated profile for ${profileId}`)
    }

    if (existing) {
      if (existing.profileId !== profileId) {
        // Correct ownership if needed
        updateSessionProfile(this.rootDir, session.id, profileId)
        appendWorklog(this.rootDir, session.id, { 
          type: "note", 
          summary: `Session ownership transitioned from ${existing.profileId} to ${profileId}` 
        })
      }
      
      const lastResumeAt = this.recentResumeAt.get(session.id) ?? 0
      const lastEntry = existing.worklog.at(-1)
      const lastWasRecentResume =
        Date.now() - lastResumeAt < 5_000 ||
        lastEntry?.type === "session" &&
        lastEntry.summary === "Session resumed" &&
        Date.now() - Date.parse(lastEntry.at) < 5_000
      if (!lastWasRecentResume) {
        this.recentResumeAt.set(session.id, Date.now())
        appendWorklog(this.rootDir, session.id, { type: "session", summary: "Session resumed" })
        this.emit({ type: "session.resumed", sessionId: session.id })
      }
    } else {
      this.emit({ type: "session.created", sessionId: session.id, title: session.title })
    }
    return session
  }

  listSessions() {
    return listSessions(this.rootDir)
  }

  getSession(sessionId: string) {
    return getSession(this.rootDir, sessionId)
  }

  private scheduleMemoryReview(
    sessionId: string,
    profileId: string,
    trigger: "post-turn" | "pre-compact" | "session-end",
    sessionSnapshot?: SessionRecord | null,
  ) {
    const snapshot = sessionSnapshot ?? getSession(this.rootDir, sessionId)
    if (!snapshot || snapshot.id.startsWith("agent-")) return
    void (async () => {
      try {
        await runMemoryAgentReview(this.rootDir, snapshot, profileId, trigger)
      } catch (error) {
        console.error(`Memory agent failed (${trigger}) for ${sessionId}:`, error)
      }
    })()
  }

  tailEvents(sessionId: string, lines?: number) {
    return tailEvents(this.rootDir, sessionId, lines)
  }

  async processMessage(sessionId: string, text: string) {
    if (this.activeSessions.has(sessionId)) {
      throw createSessionBusyError(sessionId)
    }
    this.activeSessions.add(sessionId)
    loadAndApplyModelSettings(process.env)
    appendMessage(this.rootDir, sessionId, "user", text)
    this.emit({ type: "message.received", sessionId, role: "user", text })
    await this.transitionState(sessionId, "running")
    
    // Determine profileId from session
    const session = this.getSession(sessionId)
    const profileId = (session as any)?.profileId ?? "default"

    await this.runTurn(sessionId, text, profileId)
  }

  async runTurn(sessionId: string, lastUserText: string, profileId = "default") {
    const turnStartedAt = Date.now()
    const abortController = new AbortController()
    const telegramTyping = startTelegramTypingIndicator(sessionId)
    this.abortControllers.set(sessionId, abortController)
    
    try {
      if (lastUserText.startsWith("/")) {
        const reply = await this.runSlashCommand(sessionId, lastUserText)
        if (reply === "__SESSION_RESET__") {
          // Session was reset — run startup turn with fresh context
          const resetSession = getSession(this.rootDir, sessionId)
          const resetProfileId = (resetSession as SessionRecord & { profileId?: string } | null)?.profileId ?? "default"
          const resetWorkspaceContext = getWorkspaceContext(this.rootDir, resetProfileId, { isMainSession: true })
          const startupPrompt = resetWorkspaceContext.bootstrapPending
            ? "A brand-new workspace bootstrap is pending. Start the first-run ritual now using the injected BOOTSTRAP, IDENTITY, USER, SOUL, and AGENTS context. Greet briefly, then ask exactly one short onboarding question. Do not dump a checklist or mention internal files unless the user asks."
            : "A new session was started via /new. Run your Session Startup sequence — read your required core files (SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, MEMORY.md) before responding. Then greet the user in your configured persona. Keep it to 1-3 sentences. Do not mention internal steps, files, tools, or reasoning."
          this.activeSessions.delete(sessionId)
          return await this.processMessage(sessionId, startupPrompt)
        }
        appendMessage(this.rootDir, sessionId, "assistant", reply)
        this.emit({ type: "message.received", sessionId, role: "assistant", text: reply })
        this.emit({
          type: "turn.completed",
          sessionId,
          role: "assistant",
          durationMs: Date.now() - turnStartedAt,
        })
        const telegramChatId = getTelegramChatId(sessionId)
        if (telegramChatId && reply) {
          try {
            const config = readChannelsConfig()
            if (config.telegram?.enabled && config.telegram.token) {
              await sendTelegramMessage(config.telegram.token, telegramChatId, reply)
            }
          } catch {}
        }
        await this.transitionState(sessionId, "idle")
        this.scheduleMemoryReview(sessionId, profileId, "post-turn")
        return { finalText: reply, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
      } else {
        const session = getSession(this.rootDir, sessionId)
        if (!session) throw new Error(`Session ${sessionId} not found`)
        const apiStartedAt = Date.now()
        const isMainSession = !session.id.startsWith("agent-") && !session.id.startsWith("telegram-")
        const [gitContext, dateContext, workspaceContext] = await Promise.all([
          getGitContext(this.rootDir),
          Promise.resolve(getDateContext()),
          Promise.resolve(getWorkspaceContext(this.rootDir, profileId, { isMainSession })),
        ])
        const webSearchConfig = readWebSearchConfig()
        const turn = await runAssistantTurn(
          session,
          this.rootDir,
          async (tool, input, context, toolUseId) => this.executeTool(sessionId, tool, input, { ...context, sessionId, orchestrator: this.orchestrator }, toolUseId, profileId),
          {
            rootDir: this.rootDir,
            cwd: this.rootDir,
            getMcpClient: async serverName => this.ensureMcpClient(serverName, sessionId),
            profileId,
            orchestrator: this.orchestrator,
          },
          { contextExtras: { gitContext, dateContext, workspaceContext, adultMode: this.adultModeSessions.has(sessionId), webSearchProvider: webSearchConfig.provider }, costState: this.costState, abortSignal: abortController.signal },
        )
        if (turn.usage) {
          recordApiCall(
            this.costState,
            getEffectiveModelConfig().model,
            {
              inputTokens: turn.usage.inputTokens,
              outputTokens: turn.usage.outputTokens,
            },
            Date.now() - apiStartedAt,
          )
        }
        const userFacingText = sanitizeExternalAssistantText(sessionId, turn.finalText)
        appendMessage(this.rootDir, sessionId, "assistant", userFacingText)
        this.emit({ type: "message.received", sessionId, role: "assistant", text: userFacingText })
        this.emit({
          type: "turn.completed",
          sessionId,
          role: "assistant",
          durationMs: Date.now() - turnStartedAt,
          usage: turn.usage,
        })
        
        const telegramChatId = getTelegramChatId(sessionId)
        if (telegramChatId && userFacingText) {
          try {
            const config = readChannelsConfig()
            if (config.telegram?.enabled && config.telegram.token) {
              await sendTelegramMessage(config.telegram.token, telegramChatId, userFacingText)
            }
          } catch (e) {
            console.error("Failed to send reply back to telegram", e)
          }
        }
        await this.transitionState(sessionId, turn.error ? "error" : "idle")
        this.scheduleMemoryReview(sessionId, profileId, "post-turn")
        return turn
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.emit({ type: "error", sessionId, error: "Stopped" })
        await this.transitionState(sessionId, "idle")
        throw error
      }
      const message = sanitizeExternalAssistantText(sessionId, error instanceof Error ? error.message : String(error))
      this.emit({ type: "error", sessionId, error: message })
      appendMessage(this.rootDir, sessionId, "assistant", message)
      this.emit({ type: "message.received", sessionId, role: "assistant", text: message })
      await this.transitionState(sessionId, "error")
      return {
        finalText: message,
        steps: [{ type: "final", message }],
        error: message,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }
    } finally {
      telegramTyping?.stop()
      this.activeSessions.delete(sessionId)
      this.abortControllers.delete(sessionId)
    }
  }

  abortSession(sessionId: string) {
    const controller = this.abortControllers.get(sessionId)
    if (controller) {
      controller.abort()
    }
  }

  consumeRestartRequest() {
    const requested = this.restartRequested
    this.restartRequested = false
    return requested
  }

  private async transitionState(sessionId: string, state: "idle" | "running" | "error") {
    setSessionState(this.rootDir, sessionId, state)
    this.emit({ type: "state.changed", sessionId, state })
  }

  emit(event: AgentEvent) {
    appendEvent(this.rootDir, event)
    void this.mirrorTelegramEvent(event)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error("Runtime event listener error:", err)
      }
    }
  }

  private async mirrorTelegramEvent(event: AgentEvent) {
    const chatId = getTelegramChatId(event.sessionId)
    if (!chatId) return
    void chatId
  }

  private async ensureMcpClient(serverName: string, sessionId: string) {
    const server = getDefaultMcpServers(this.rootDir)[serverName as "demo"]
    if (!server) throw new Error(`Unknown MCP server: ${serverName}`)
    let client = this.mcpClients.get(serverName)
    if (!client) {
      client = new StdioMcpClient(server.command, server.cwd)
      await client.initialize()
      this.mcpClients.set(serverName, client)
      this.emit({ type: "mcp.connected", sessionId, server: serverName })
    }
    return client
  }

  private async runSlashCommand(sessionId: string, line: string) {
    const [command, ...rest] = line.trim().split(" ")
    switch (command) {
      case "/help":
        return [
          "Commands:",
          "/help",
          "/status",
          "/sessions",
          "/tool <name> <json>",
          "/mcp tools <server>",
          "/mcp resources <server>",
          "/mcp read <server> <uri>",
          "/mcp call <server> <tool> <json>",
          "/model",
          "/model info",
          "/model set <base_url|api_key|model> <value>",
          "/model reset",
          "/history [limit]",
          "/cost",
          "/compact [max-messages]",
          "/stats",
          "/doctor",
          "/update",
          "/config [show|set <field> <value>]",
          "/adult — Toggle adult content mode",
          "/websearch — Configure web search engine",
          "/new — Reset session and restart agent",
        ].join("\n")
      case "/status": {
        return JSON.stringify(
          {
            session: getSession(this.rootDir, sessionId),
            model: redactSensitiveModelSettings(readModelSettings()),
            tools: listTools().map(tool => tool.name),
          },
          null,
          2,
        )
      }
      case "/sessions":
        return listSessions(this.rootDir).map(item => `${item.id} ${item.state} ${item.title}`).join("\n")
      case "/tool":
        return this.runToolCommand(sessionId, rest)
      case "/mcp":
        return this.runMcpCommand(sessionId, rest)
      case "/model":
        return this.runModelCommand(rest)
      case "/history":
        return this.runHistoryCommand(sessionId, rest)
      case "/cost":
        return formatCostSummary(this.costState)
      case "/compact": {
        const session = getSession(this.rootDir, sessionId)
        const profileId = (session as SessionRecord & { profileId?: string } | null)?.profileId ?? "default"
        this.scheduleMemoryReview(sessionId, profileId, "pre-compact", session)
        const max = rest[0] ? Number.parseInt(rest[0], 10) : undefined
        const result = compactSession(this.rootDir, sessionId, max ? { maxMessages: max } : {})
        return `Compacted ${result.compacted} message${result.compacted !== 1 ? "s" : ""}. ${result.remaining} remaining.`
      }
      case "/stats": {
        const stats = getSessionStats(this.rootDir, sessionId)
        if (!stats) return "Session not found."
        return [
          `Messages: ${stats.messageCount}`,
          `Characters: ${stats.totalChars.toLocaleString()}`,
          `Worklog entries: ${stats.worklogEntries}`,
          `Created: ${stats.createdAt}`,
          `Updated: ${stats.updatedAt}`,
          `State: ${stats.state}`,
        ].join("\n")
      }
      case "/doctor": {
        return this.runDoctor()
      }
      case "/update": {
        return this.runUpdate()
      }
      case "/websearch": {
        const config = readWebSearchConfig()
        return [
          `Web search mode: ${config.provider}`,
          "Interactive configuration is available in the local CLI via /websearch.",
          "From Telegram, use the local terminal client to change it.",
        ].join("\n")
      }
      case "/config": {
        return this.runConfig(rest)
      }
      case "/adult": {
        const isActive = this.adultModeSessions.has(sessionId)
        if (isActive) {
          this.adultModeSessions.delete(sessionId)
          return "Modo adulto desactivado."
        }
        this.adultModeSessions.add(sessionId)
        return "Modo adulto activado."
      }
      case "/new":
      case "/reset": {
        const session = getSession(this.rootDir, sessionId)
        const profileId = (session as SessionRecord & { profileId?: string } | null)?.profileId ?? "default"
        this.scheduleMemoryReview(sessionId, profileId, "session-end", session)
        resetSession(this.rootDir, sessionId)
        return "__SESSION_RESET__"
      }
      default:
        return `Unknown slash command: ${command}`
    }
  }

  private async runToolCommand(sessionId: string, rest: string[]) {
    const name = rest[0]
    if (!name) {
      return listTools().map(tool => `${tool.name} - ${tool.description}`).join("\n")
    }
    const tool = getTool(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    const session = getSession(this.rootDir, sessionId)
    const raw = rest.slice(1).join(" ").trim()
    const input = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    const output = await this.executeTool(sessionId, tool.name, input, {
      rootDir: this.rootDir,
      cwd: this.rootDir,
      getMcpClient: async serverName => this.ensureMcpClient(serverName, sessionId),
      profileId: session?.profileId,
      sessionId,
      orchestrator: this.orchestrator,
    })
    return JSON.stringify(output, null, 2)
  }

  private async executeTool(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    context: {
      rootDir: string
      cwd: string
      getMcpClient?: (serverName: string) => Promise<StdioMcpClient>
      profileId?: string
      sessionId?: string
      orchestrator?: AgentOrchestrator
    },
    toolUseId?: string,
    profileId?: string,
  ) {
    const tool = getTool(toolName)
    if (!tool) throw new Error(`Unknown tool: ${toolName}`)
    const permission = await checkToolPermission(tool.name, input, {
      rootDir: this.rootDir,
      sessionId,
      profileId: profileId ?? context.profileId,
    })
    if (permission.behavior !== "allow") {
      const message = permission.message ?? `Permission denied for tool ${tool.name}.`
      appendWorklog(this.rootDir, sessionId, {
        type: "tool",
        summary: `Tool ${tool.name} blocked: ${message}`,
      })
      this.emit({ type: "error", sessionId, error: message })
      throw new Error(message)
    }
    this.emit({ type: "tool.start", sessionId, toolUseId, tool: tool.name, input })
    const toolStartedAt = Date.now()
    try {
      const output = await tool.run(input, { ...context, profileId: profileId ?? context.profileId })
      await runPostToolHooks(tool.name, input, {
        rootDir: this.rootDir,
        sessionId,
        profileId: profileId ?? context.profileId,
      }, output)
      const failure = getToolFailureMessage(tool.name, output)
      if (failure) throw createToolExecutionError(failure, output)
      recordToolCall(this.costState, Date.now() - toolStartedAt)
      appendWorklog(this.rootDir, sessionId, {
        type: "tool",
        summary: `Tool ${tool.name} finished successfully`,
      })
      this.emit({ type: "tool.finish", sessionId, toolUseId, tool: tool.name, ok: true, output })
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const output = "output" in Object(error) ? (error as ToolExecutionError).output : undefined
      recordToolCall(this.costState, Date.now() - toolStartedAt)
      appendWorklog(this.rootDir, sessionId, {
        type: "tool",
        summary: `Tool ${tool.name} failed: ${message}`,
      })
      this.emit({ type: "tool.finish", sessionId, toolUseId, tool: tool.name, ok: false, output: outputWithError(output, message) })
      throw error
    }
  }

  recoverSessions(summary?: string) {
    return recoverRunningSessions(this.rootDir, summary)
  }

  close() {
    for (const client of this.mcpClients.values()) {
      client.close()
    }
    this.mcpClients.clear()
    this.recoverSessions("Recovered after daemon shutdown")
  }

  private async runMcpCommand(sessionId: string, rest: string[]) {
    const action = rest[0]
    const serverName = rest[1] ?? "demo"
    const client = await this.ensureMcpClient(serverName, sessionId)
    if (action === "tools") {
      return JSON.stringify(await client.listTools(), null, 2)
    }
    if (action === "resources") {
      return JSON.stringify(await client.listResources(), null, 2)
    }
    if (action === "read") {
      return JSON.stringify(await client.readResource(rest[2] ?? "monolito://demo/status"), null, 2)
    }
    if (action === "call") {
      const tool = rest[2]
      if (!tool) throw new Error("Usage: /mcp call <server> <tool> <json>")
      const rawArgs = rest.slice(3).join(" ").trim()
      const args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {}
      this.emit({ type: "mcp.called", sessionId, server: serverName, tool })
      return JSON.stringify(await client.callTool(tool, args), null, 2)
    }
    return "Usage: /mcp tools <server> | /mcp resources <server> | /mcp read <server> <uri> | /mcp call <server> <tool> <json>"
  }

  private async runModelCommand(rest: string[]) {
    const action = (rest[0] ?? "").trim()
    if (!action || action === "info" || action === "show" || action === "status") {
      const storedSettings = readModelSettings()
      const effective = getEffectiveModelConfig()
      return [
        `Protocol: ${storedSettings.modelConfig.protocol}`,
        `Base URL: ${effective.baseUrl || "(system/default)"}`,
        `API key: ${maskApiKey(effective.apiKey)}`,
        `Model: ${effective.model || "(unset)"}`,
        "",
        "Persisted settings:",
        JSON.stringify(redactSensitiveModelSettings(storedSettings), null, 2),
      ].join("\n")
    }
    if (action === "reset") {
      const settings = draftToSettings(
        {
          protocol: MODEL_PROTOCOL,
          baseUrl: "",
          apiKey: "",
          model: "",
        },
        { env: process.env },
      )
      saveModelSettings(settings)
      applyModelSettingsToEnv(process.env, settings)
      return "Model settings reset to defaults and applied."
    }

    const nextDraft = settingsToDraft(readModelSettings({ env: process.env }))
    if (action === "set") {
      const field = (rest[1] ?? "").trim()
      const value = rest.slice(2).join(" ").trim()
      if (!field || !value) throw new Error("Usage: /model set <base_url|api_key|model> <value>")
      if (field === "base_url") nextDraft.baseUrl = value
      else if (field === "api_key") nextDraft.apiKey = value
      else if (field === "model") nextDraft.model = value
      else throw new Error("Usage: /model set <base_url|api_key|model> <value>")
    } else {
      nextDraft.model = rest.join(" ").trim()
    }

    nextDraft.protocol = MODEL_PROTOCOL
    const errors = validateModelDraft(nextDraft, process.env)
    if (errors.length > 0) throw new Error(errors[0] ?? "Invalid model configuration")

    const settings = draftToSettings(nextDraft, { env: process.env })
    saveModelSettings(settings)
    applyModelSettingsToEnv(process.env, settings)
    const effective = getEffectiveModelConfig()
    return [
      "Saved model settings.",
      `Protocol: ${settings.modelConfig.protocol}`,
      `Base URL: ${effective.baseUrl || "(system/default)"}`,
      `API key: ${maskApiKey(effective.apiKey)}`,
      `Model: ${effective.model || "(unset)"}`,
    ].join("\n")
  }

  private async runHistoryCommand(sessionId: string, rest: string[]) {
    const limitRaw = rest[0]
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20
    if (!Number.isFinite(limit) || limit < 1) throw new Error("Usage: /history [limit]")
    const session = getSession(this.rootDir, sessionId)
    if (!session || session.worklog.length === 0) return "No history entries for this session yet."
    return session.worklog.slice(-limit).map(entry => `${entry.at} [${entry.type}] ${entry.summary}`).join("\n")
  }

  private async runDoctor(): Promise<string> {
    const lines: string[] = ["=== Monolito V2 Doctor ==="]
    const effective = getEffectiveModelConfig()
    const hasApiKey = effective.apiKey.length > 0
    const hasBaseUrl = effective.baseUrl.length > 0
    const hasModel = effective.model.length > 0
    lines.push(`API Key: ${hasApiKey ? "OK" : "MISSING"}`)
    lines.push(`Base URL: ${hasBaseUrl ? effective.baseUrl : "MISSING"}`)
    lines.push(`Model: ${hasModel ? effective.model : "MISSING"}`)
    lines.push(`Workspace: ${this.rootDir}`)
    try {
      const stats = statSync(join(this.rootDir, "package.json"))
      lines.push(`package.json: OK (${stats.size} bytes)`)
    } catch {
      lines.push("package.json: MISSING")
    }
    lines.push(`Sessions: ${listSessions(this.rootDir).length}`)
    lines.push(`Cost: ${formatCostSummary(this.costState)}`)
    return lines.join("\n")
  }

  private async runUpdate(): Promise<string> {
    try {
      const branch = await runGitCommand(this.rootDir, ["rev-parse", "--abbrev-ref", "HEAD"])
      if (!branch) return "Update failed: could not determine current git branch."

      const remoteUrl = await runGitCommand(this.rootDir, ["remote", "get-url", "origin"]).catch(() => "")
      if (!remoteUrl) {
        return "Update failed: no git remote named 'origin' is configured."
      }

      const status = await runGitCommand(this.rootDir, ["status", "--porcelain"])
      let stashLabel = ""
      if (status.trim()) {
        stashLabel = `monolito-update-backup-${new Date().toISOString()}`
        await runGitCommand(this.rootDir, ["stash", "push", "--include-untracked", "--message", stashLabel])
        const statusAfterStash = await runGitCommand(this.rootDir, ["status", "--porcelain"])
        if (statusAfterStash.trim()) {
          return buildResidualUpdateError(this.rootDir, stashLabel, statusAfterStash)
        }
      }

      const currentHead = await runGitCommand(this.rootDir, ["rev-parse", "HEAD"])
      await runGitCommand(this.rootDir, ["fetch", "--prune", "origin", branch])
      const remoteHead = await runGitCommand(this.rootDir, ["rev-parse", `origin/${branch}`]).catch(() => "")
      if (!remoteHead) {
        return `Update failed: origin/${branch} was not found after fetch.`
      }
      if (currentHead === remoteHead) {
        return [
          `Already up to date on ${branch}.`,
          `Remote: ${remoteUrl}`,
        ].join("\n")
      }

      await runGitCommand(this.rootDir, ["pull", "--ff-only", "origin", branch])
      const nextHead = await runGitCommand(this.rootDir, ["rev-parse", "--short", "HEAD"])
      this.restartRequested = true
      return [
        `Updated successfully from origin/${branch}.`,
        `Remote: ${remoteUrl}`,
        `Current revision: ${nextHead}`,
        stashLabel ? `Local changes were backed up automatically to stash: ${stashLabel}` : "",
        "Daemon restart scheduled automatically.",
      ].filter(Boolean).join("\n")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Update failed: ${message}`
    }
  }

  private async runConfig(rest: string[]): Promise<string> {
    const action = rest[0]
    const settings = readModelSettings()
    if (!action || action === "show") {
      return JSON.stringify(redactSensitiveModelSettings(settings), null, 2)
    }
    if (action === "set") {
      const field = rest[1]
      const value = rest.slice(2).join(" ")
      if (!field || !value) return "Usage: /config set <field> <value>"
      const draft = settingsToDraft(settings)
      if (field === "base_url") draft.baseUrl = value
      else if (field === "api_key") draft.apiKey = value
      else if (field === "model") draft.model = value
      else return `Unknown field: ${field}`
      const errors = validateModelDraft(draft, process.env)
      if (errors.length > 0) return `Invalid: ${errors[0]}`
      const next = draftToSettings(draft, { env: process.env })
      saveModelSettings(next)
      applyModelSettingsToEnv(process.env, next)
      return `Saved ${field} = ${field === "api_key" ? maskApiKey(value) : value}`
    }
    return "Usage: /config [show | set <field> <value>]"
  }

  // --- Public query methods (for CLI local commands) ---
  queryCost() {
    return formatCostSummary(this.costState)
  }

  queryStats(sessionId: string) {
    const stats = getSessionStats(this.rootDir, sessionId)
    if (!stats) return "Session not found."
    return [
      `Messages: ${stats.messageCount}`,
      `Characters: ${stats.totalChars.toLocaleString()}`,
      `Worklog entries: ${stats.worklogEntries}`,
      `Created: ${stats.createdAt}`,
      `Updated: ${stats.updatedAt}`,
      `State: ${stats.state}`,
    ].join("\n")
  }

  queryCompact(sessionId: string, maxMessages?: number) {
    const result = compactSession(this.rootDir, sessionId, maxMessages ? { maxMessages } : {})
    return `Compacted ${result.compacted} message${result.compacted !== 1 ? "s" : ""}. ${result.remaining} remaining.`
  }

  queryDoctor() {
    return this.runDoctor()
  }

  queryModelInfo() {
    const settings = readModelSettings()
    const effective = getEffectiveModelConfig()
    return [
      `Protocol: ${settings.modelConfig.protocol}`,
      `Base URL: ${effective.baseUrl || "(system/default)"}`,
      `API key: ${maskApiKey(effective.apiKey)}`,
      `Model: ${effective.model || "(unset)"}`,
    ].join("\n")
  }

  async queryConfig(action?: string, field?: string, value?: string) {
    return await this.runConfig(action ? [action, field, value].filter(Boolean) as string[] : [])
  }
}
