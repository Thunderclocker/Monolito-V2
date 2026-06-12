import { stdin, stdout } from "node:process"
import { spawn, execSync, execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import { readDaemonLock, type AgentEvent, type SessionRecord, type SessionSummary, MAIN_SESSION_ID } from "../../core/ipc/protocol.ts"
import {
  parseTaskNotification,
  renderToolFinish,
  renderToolStart,
  renderToolStartText,
  stringifyPretty,
  truncate,
  ToolUseRenderer,
} from "../../core/renderer/toolRenderer.ts"
import { DaemonClient } from "../../core/client/daemonClient.ts"
import { applyCompletion, createInteractiveCompleter, findCommonPrefix } from "./tui/autocomplete.ts"
import { ANSI } from "./tui/ansi.ts"
import { getHeaderState, refreshMinimaxBalance } from "./tui/header.ts"
import { commitPromptHistory, createPromptHistory, historyDown, historyUp } from "./tui/history.ts"
import { readModelSettings } from "../../core/runtime/modelConfig.ts"
import { getActiveProfile } from "../../core/runtime/modelRegistry.ts"
import {
  formatConfig,
  formatDoctor,
  formatHelp,
  formatModelInfo,
  formatSessionsTable,
  type FormattedBlock,
} from "./tui/formatters.ts"
import {
  appendTranscriptBlocks,
  clampScrollOffset,
  flattenTranscript,
  getTranscriptVisibleRows,
  MAX_TRANSCRIPT_BLOCKS,
  parseMouseEvent,
  renderScreen,
} from "./tui/renderer.ts"
import type {
  CliSessionError,
  ComposerState,
  TranscriptBlock,
  TranscriptViewport,
} from "./tui/types.ts"
import { openModelMenu, processMenuInput } from "./tui/modelMenu.ts"
import { openChannelMenu, processChannelMenuInput } from "./tui/channelMenu.ts"
import { openWebSearchMenu, processWebSearchMenuInput } from "./tui/websearchMenu.ts"
import { isMenuSchemaEnvelope } from "../../core/menu/schema.ts"
import { isRuntimeControlCommand } from "./runtimeControlCommands.ts"
import { buildMasterDashboard } from "../../core/menu/masterDashboard.ts"
import { openMasterDashboard, processMasterMenuInput } from "./tui/uiManager.ts"
import { getWorkspaceContext } from "../../core/context/workspaceContext.ts"

const execFileAsync = promisify(execFile)

function formatDuration(durationMs: number) {
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

function formatUsage(
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  },
) {
  if (!usage) return "tokens: n/d"
  const parts: string[] = []
  if (typeof usage.inputTokens === "number") parts.push(`in ${usage.inputTokens}`)
  if (typeof usage.outputTokens === "number") parts.push(`out ${usage.outputTokens}`)
  if (typeof usage.totalTokens === "number") parts.push(`total ${usage.totalTokens}`)
  return parts.length > 0 ? parts.join(" · ") : "tokens: n/d"
}

function isPrintableCharacter(value: string) {
  return /^[\u0020-\u007e\u00a0-\u{10ffff}]$/u.test(value)
}

function isInternalToolEnvelope(text: string) {
  return /^(TOOL_USE|TOOL_RESULT|TOOL_CALL_ERROR)\b/.test(text.trim())
}

function getTelegramSessionChatId(sessionId: string) {
  return sessionId.startsWith("telegram-") ? sessionId.slice("telegram-".length) : null
}

function unwrapChannelMessage(text: string) {
  const clean = text.startsWith("<slash-reply>") ? text.slice("<slash-reply>".length) : text
  const match = clean.match(/^<channel\b[^>]*>\n?([\s\S]*?)\n?<\/channel>$/)
  return match?.[1] ?? clean
}

/**
 * Self-heal: ensure systemd is configured to autostart the daemon.
 *
 * This runs every time the CLI starts and the daemon is not reachable.
 * It checks the three things that the install script is supposed to set up:
 *
 *   1. Linger=yes for the current user (required for user services to run
 *      at boot without a login session)
 *   2. The systemd unit file is present and current
 *   3. The unit is enabled (so systemd will start it on next boot)
 *
 * If any is missing or broken, we try to fix it. Failures are logged but
 * do not block the daemon from starting in the current session — we
 * prefer a working daemon NOW over refusing to start because autostart
 * is misconfigured.
 *
 * Returns true if autostart is configured, false if we couldn't fix it.
 */
function repairSystemdAutostart(rootDir: string): boolean {
  if (process.platform !== "linux") return false
  if (!existsSync("/run/systemd/system")) return false  // no systemd running

  const log = (msg: string) => console.error(`[monolito] ${msg}`)
  let allGood = true

  // 1. Linger — try without sudo first, then with sudo
  try {
    const linger = execSync(`loginctl show-user ${process.env.USER ?? ""} 2>/dev/null | grep -q "Linger=yes"`, {
      stdio: "ignore",
    })
    void linger
  } catch {
    log("Linger no está activo. Intentando habilitar...")
    try {
      execSync("loginctl enable-linger $USER", { stdio: "ignore", shell: "/bin/bash" })
    } catch {
      try {
        execSync("sudo loginctl enable-linger $USER", { stdio: "ignore", shell: "/bin/bash" })
      } catch {
        log("WARN: no pude habilitar linger. El daemon no va a auto-arrancar al boot.")
        log("      Solución: sudo loginctl enable-linger $USER")
        allGood = false
      }
    }
  }

  // 2. Materialize the unit if missing
  const unitPath = `${process.env.HOME}/.config/systemd/user/monolito.service`
  if (!existsSync(unitPath)) {
    log("Unit file monolito.service no existe. Materializando...")
    try {
      execSync(
        `node --experimental-strip-types ${rootDir}/src/apps/daemon.ts --write-unit-only`,
        { stdio: "ignore", cwd: rootDir },
      )
    } catch (e) {
      log(`WARN: no pude materializar el unit: ${e instanceof Error ? e.message : String(e)}`)
      allGood = false
    }
  }

  // 3. daemon-reload + enable (idempotent)
  try {
    execSync("systemctl --user daemon-reload", { stdio: "ignore" })
  } catch (e) {
    log(`WARN: systemctl --user daemon-reload falló: ${e instanceof Error ? e.message : String(e)}`)
    allGood = false
  }
  try {
    execSync("systemctl --user enable monolito.service", { stdio: "ignore" })
  } catch (e) {
    log(`WARN: systemctl --user enable monolito.service falló: ${e instanceof Error ? e.message : String(e)}`)
    allGood = false
  }

  if (allGood) {
    log("Autostart de systemd verificado y reparado.")
  }
  return allGood
}

async function ensureDaemon(client: DaemonClient, rootDir: string) {
  try {
    await client.connect()
    return
  } catch {
    // Intentar iniciar el servicio systemd en Linux si está disponible
    if (process.platform === "linux") {
      // First, repair the autostart config so that the daemon we are about
      // to start will also auto-start on the next boot. This is what the
      // user actually wants: install.sh may have been run a while ago and
      // a `loginctl enable-linger` could have been lost, or the unit
      // could have been wiped. We don't want the user to re-run install.sh.
      repairSystemdAutostart(rootDir)

      try {
        execSync("systemctl --user start monolito.service", { stdio: "ignore" })
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 250))
          try {
            await client.connect()
            return
          } catch {
            // continuar esperando
          }
        }
      } catch {
        // Fallback a spawn manual si systemd falla o no está configurado
      }
    }

    const daemonPath = `${rootDir}/src/apps/daemon.ts`
    const child = spawn(process.execPath, ["--experimental-strip-types", daemonPath], {
      cwd: rootDir,
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250))
      try {
        await client.connect()
        return
      } catch {
        // keep waiting
      }
    }
    throw new Error("Daemon failed to start within 5s")
  }
}

async function restartDaemon(client: DaemonClient, rootDir: string) {
  const previousLock = readDaemonLock(rootDir)
  const previousSignature = previousLock ? `${previousLock.pid}:${previousLock.startedAt}` : null
  try {
    await client.stopDaemon()
  } catch {
    // continue; we still attempt to start a fresh daemon
  }
  client.close()
  const deadline = Date.now() + 15_000
  let lastError: unknown = null

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300))
    try {
      await ensureDaemon(client, rootDir)
      const nextLock = readDaemonLock(rootDir)
      const nextSignature = nextLock ? `${nextLock.pid}:${nextLock.startedAt}` : null
      if (!previousSignature || (nextSignature && nextSignature !== previousSignature)) {
        return
      }
      client.close()
    } catch (error) {
      lastError = error
    }
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : ""
  throw new Error(`Daemon restart could not be verified within 15s${detail}`)
}

async function runGit(rootDir: string, args: string[]) {
  const result = await execFileAsync("git", args, {
    cwd: rootDir,
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  return result.stdout.trim()
}

function makeUpdateBackupLabel(prefix: string) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`
}

async function backupCurrentHead(rootDir: string, branch: string, currentHead: string) {
  const backupBranch = makeUpdateBackupLabel(`monolito-update-backup-${branch}`)
  await runGit(rootDir, ["branch", backupBranch, currentHead])
  return backupBranch
}

function isBootstrapSessionCandidate(session: SessionRecord) {
  if (session.id.startsWith("telegram-") || session.id.startsWith("agent-")) return false
  return session.messages.length === 0
}

function getBootstrapStartupPrompt(isFreshSession: boolean) {
  if (isFreshSession) {
    return "El bootstrap del workspace sigue pendiente. Inicia ahora el ritual de primer arranque usando el contexto inyectado de BOOT_BOOTSTRAP, BOOT_IDENTITY, BOOT_USER, BOOT_SOUL y BOOT_AGENTS. Deja que el modelo orqueste la conversacion segun lo ya sabido. Responde en el idioma del usuario; si aun no hay una preferencia clara, comienza en espanol neutro y adapta el idioma enseguida si el usuario marca otro. Saluda brevemente y haz exactamente una sola pregunta corta por turno. No recites una checklist ni menciones almacenamiento interno salvo que el usuario lo pida."
  }
  return "El bootstrap del workspace sigue pendiente. Retoma el onboarding desde el contexto inyectado de BOOT_BOOTSTRAP, BOOT_IDENTITY, BOOT_USER, BOOT_SOUL y BOOT_AGENTS. Deja que el modelo conduzca la siguiente pregunta segun lo ya conocido. Responde en el idioma del usuario y mantente natural, breve y conversacional. Haz exactamente una sola pregunta corta por turno. No menciones almacenamiento interno salvo que el usuario lo pida."
}

function hasConfiguredModel() {
  const activeProfileModel = getActiveProfile()?.model?.trim() ?? ""
  if (activeProfileModel) return true
  const settings = readModelSettings()
  const configuredModel = settings.env.ANTHROPIC_MODEL.trim()
  return configuredModel.length > 0
}

function openMissingModelMenu() {
  return openModelMenu(
    [
      "No model is configured yet.",
      "Opened the model menu automatically so you can choose one before starting.",
    ].join("\n"),
    "info",
  )
}

async function stashLocalChangesForUpdate(rootDir: string) {
  const status = await runGit(rootDir, ["status", "--porcelain"])
  if (!status.trim()) return null

  const stashLabel = makeUpdateBackupLabel("monolito-update-stash")
  await runGit(rootDir, ["stash", "push", "--include-untracked", "--message", stashLabel])
  const statusAfterStash = await runGit(rootDir, ["status", "--porcelain"])
  if (statusAfterStash.trim()) {
    const rootName = rootDir.split("/").filter(Boolean).at(-1) ?? "repo"
    const nestedCloneMarker = `?? ${rootName}/`
    const details = [
      `working tree still dirty after automatic backup stash ${stashLabel}`,
      statusAfterStash,
    ]
    if (statusAfterStash.includes(nestedCloneMarker)) {
      details.push(
        `Detected a nested clone or duplicate project directory inside the repo: ${rootName}/`,
        `Move or remove ${rootName}/${rootName} if it exists, then run /update again.`,
      )
    }
    throw new Error(details.join("\n"))
  }
  return stashLabel
}

function renderExternalTelegramEvent(event: AgentEvent): TranscriptBlock[] {
  const chatId = getTelegramSessionChatId(event.sessionId)
  if (!chatId) return []

  switch (event.type) {
    case "message.received": {
      if (event.role === "user") {
        return [{
          type: "event",
          label: "telegram",
          tone: "info",
          text: `telegram ${chatId}: ${unwrapChannelMessage(event.text)}`,
        }]
      }
      if (event.role === "assistant" && !isInternalToolEnvelope(event.text)) {
        const taskNotification = parseTaskNotification(event.text)
        if (taskNotification) {
          const tone = taskNotification.status === "completed" ? "success"
            : taskNotification.status === "failed" || taskNotification.status === "killed" ? "error"
            : "info"
          return [{
            type: "event",
            label: "telegram",
            tone,
            text: `telegram ${chatId} agent: ${taskNotification.summary ?? "Agent update"}`,
          }]
        }
        return [{
          type: "event",
          label: "telegram",
          tone: "success",
          text: `telegram ${chatId} response: ${event.text}`,
        }]
      }
      return []
    }
    case "tool.start": {
      const line = renderToolStart(event.tool, event.input)
      return [{
        type: "event",
        label: "telegram",
        tone: "info",
        text: `telegram ${chatId} ${renderToolStartText(line, "└─ ")}`,
      }]
    }
    case "tool.finish": {
      const line = renderToolFinish(event.tool, event.ok, event.output)
      if (!line.text) return []
      return [{
        type: "event",
        label: "telegram",
        tone: event.ok ? "info" : "error",
        text: `telegram ${chatId} ${line.text}`,
        replacesLastEvent: true,
      }]
    }
    case "turn.completed":
      return [{
        type: "event",
        label: "telegram",
        tone: "info",
        text: `telegram ${chatId} turn completed`,
      }]
    case "error":
      return [{
        type: "event",
        label: "telegram",
        tone: "error",
        text: `telegram ${chatId} error: ${event.error}`,
      }]
    default:
      return []
  }
}

class InteractiveTranscriptFormatter {
  private pendingAssistantToolResults: string[] = []
  private pendingMcpCall: string | null = null

  render(event: AgentEvent): TranscriptBlock[] {
    switch (event.type) {
      case "session.created":
        return []
      case "session.resumed":
        return []
      case "state.changed":
        return []
      case "message.received":
        if (event.role === "assistant" && isInternalToolEnvelope(event.text)) {
          return []
        }
        {
          const taskNotification = parseTaskNotification(event.text)
          if (taskNotification) {
            const tone =
              taskNotification.status === "completed"
                ? "success"
                : taskNotification.status === "failed" || taskNotification.status === "killed"
                  ? "error"
                  : "info"
            const blocks: TranscriptBlock[] = [{
              type: "event",
              label: "agent",
              tone,
              text: taskNotification.summary ?? "Agent update",
            }]
            if (taskNotification.result) {
              blocks.push({
                type: "message",
                role: "assistant",
                text: taskNotification.result,
                ...(event.thinking ? { thinking: event.thinking } : {}),
              })
            }
            if (taskNotification.usage) {
              blocks.push({
                type: "assistant-meta",
                text: `${formatDuration(taskNotification.usage.durationMs ?? 0)} · ${taskNotification.usage.totalTokens ?? 0} tokens`,
              })
            }
            return blocks
          }
        }
        if (event.role === "user") {
          return [{ type: "message", role: "user", text: unwrapChannelMessage(event.text) }]
        }
        if (this.pendingAssistantToolResults[0] === event.text) {
          this.pendingAssistantToolResults.shift()
          return []
        }
        if (this.pendingMcpCall) {
          const pending = this.pendingMcpCall
          this.pendingMcpCall = null
          return [{ type: "event", label: "mcp", tone: "info", text: `${pending} · ${truncate(event.text, 180)}` }]
        }
        return [{
          type: "message",
          role: "assistant",
          text: unwrapChannelMessage(event.text),
          ...(event.thinking ? { thinking: event.thinking } : {}),
        }]
      case "turn.completed":
        return [{ type: "assistant-meta", text: `${formatDuration(event.durationMs)} · ${formatUsage(event.usage)}` }]
      case "todo.updated":
        return [{
          type: "todo-list",
          completed: event.completed,
          total: event.total,
          items: event.items,
        }]
      case "tool.start": {
        const line = renderToolStart(event.tool, event.input)
        const text = renderToolStartText(line, "└─ ")
        if (!text) return []
        return [{ type: "event", label: line.label, tone: line.tone, text }]
      }
      case "tool.finish": {
        if (event.ok && event.tool !== "GenerateSpeech") {
          this.pendingAssistantToolResults.push(stringifyPretty(event.output))
        }
        const line = renderToolFinish(event.tool, event.ok, event.output)
        if (line.text) {
          // Replace the in-flight `tool.start` block (same bullet, only the
          // text changes) instead of appending a second one with a "done"
          // label. Keeps a single colored bullet per tool call, like
          // upstream reference's CLI.
          return [{
            type: "event",
            label: "",
            tone: event.ok ? "info" : "error",
            text: line.text,
            replacesLastEvent: true,
          }]
        }
        return []
      }
      case "mcp.connected":
        return [{ type: "event", label: "mcp", tone: "info", text: `connected ${event.server}` }]
      case "mcp.called":
        this.pendingMcpCall = `${event.server}.${event.tool}`
        return [{ type: "event", label: "mcp", tone: "info", text: this.pendingMcpCall }]
      case "ralph.attempt": {
        const taskList = event.unfinished.slice(0, 3).join(" · ")
        const more = event.unfinished.length > 3 ? ` +${event.unfinished.length - 3} más` : ""
        return [{
          type: "event",
          label: "ralph",
          tone: "info",
          text: `intento ${event.attempt}/${event.maxAttempts} · ${event.unfinished.length} pendiente${event.unfinished.length !== 1 ? "s" : ""}: ${taskList}${more}`,
        }]
      }
      case "error":
        return [{ type: "event", label: "error", tone: "error", text: event.error }]
      default:
        return []
    }
  }
}

export async function waitForTurnCompletion(
  client: DaemonClient,
  sessionId: string,
  timeoutMs = 180_000,
) {
  return await new Promise<void>((resolve, reject) => {
    let sawRunning = false
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribeEvent()
      unsubscribeConnection()
      fn()
    }
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            "El chat principal no respondió en 90s. Cancelá con /stop y reintentá — si vuelve a colgar, es bug del flujo principal; debería haber delegado automáticamente.",
          ),
        ),
      )
    }, timeoutMs)
    const unsubscribeEvent = client.onEvent((event: AgentEvent) => {
      if (event.sessionId !== sessionId) return
      if (event.type === "state.changed" && event.state === "running") sawRunning = true
      if (event.type === "state.changed" && sawRunning && (event.state === "idle" || event.state === "error")) {
        finish(() => resolve())
      }
    })
    const unsubscribeConnection = client.onConnectionChange(connected => {
      if (connected) return
      finish(() => reject(new Error("Daemon se desconectó mientras esperaba respuesta.")))
    })
  })
}

export async function ensureCliSession(client: DaemonClient, sessionId?: string) {
  if (sessionId) {
    return (await client.ensureSession(sessionId, "Monolito v2 Resumed Session")) as SessionRecord
  }
  return (await client.ensureSession(MAIN_SESSION_ID, "Orchestrator")) as SessionRecord
}

export async function openInteractiveSession(client: DaemonClient, sessionId?: string) {
  const rootDir = process.cwd()
  const composer: ComposerState = { input: "", cursor: 0, busy: false, thinkingFrame: 0, thinkingVisible: false, suggestions: [], toolThinkingFrame: 0, toolThinkingText: "", menuState: null, channelMenuState: null, websearchMenuState: null, masterMenuState: null, masterMenuEphemeral: false, permissionPrompt: null, accumulatedThinking: "", showThinkingContent: false }
  const history = createPromptHistory(rootDir)
  const completer = createInteractiveCompleter(rootDir)
  const formatter = new InteractiveTranscriptFormatter()
  let queuedPrompt: string | null = null
  let activeSessionId = sessionId ?? "offline"
  let subscribedSessionId: string | null = null
  let connectionHealthy = client.isConnected()
  let header = getHeaderState(rootDir, activeSessionId, connectionHealthy)
  let transcript: TranscriptViewport = {
    blocks: [],
    scrollOffset: 0,
  }
  let finish: (() => void) | null = null
  let fail: ((error: Error) => void) | null = null
  let closed = false
  let monitorTimer: NodeJS.Timeout | null = null
  let thinkingTimer: NodeJS.Timeout | null = null
  let inputBuffer = ""
  let needsClear = true
  let shouldRelaunchCli = false
  let relaunchSessionId: string | undefined
  let loadedRevision = ""
  let revisionCheckInFlight = false

  const refreshHeader = () => {
    header = getHeaderState(rootDir, activeSessionId, connectionHealthy)
  }
  const redraw = () => {
    refreshHeader()
    const clear = needsClear
    needsClear = false
    renderScreen(header, transcript, composer, clear)
  }
  const startThinkingAnimation = () => {
    if (thinkingTimer) return
    thinkingTimer = setInterval(() => {
      composer.thinkingFrame = (composer.thinkingFrame + 1) % 3
      if (composer.toolThinkingText) {
        composer.toolThinkingFrame = (composer.toolThinkingFrame + 1) % 3
      }
      redraw()
    }, 350)
  }
  const stopThinkingAnimation = () => {
    if (!thinkingTimer) return
    clearInterval(thinkingTimer)
    thinkingTimer = null
    composer.thinkingFrame = 0
    composer.thinkingVisible = false
    composer.toolThinkingText = ""
    composer.toolThinkingFrame = 0
  }
  const detachRenderer = client.onEvent((event: AgentEvent) => {
    const pinnedToBottom = transcript.scrollOffset === 0
    if (event.sessionId !== activeSessionId) {
      const blocks = renderExternalTelegramEvent(event)
      if (blocks.length === 0) return
      transcript = appendTranscriptBlocks(transcript, blocks)
      if (pinnedToBottom) transcript.scrollOffset = 0
      redraw()
      return
    }

    if (event.type === "permission.request" || event.type === "destructive.confirm") {
      composer.permissionPrompt = {
        permissionId: event.type === "destructive.confirm" ? event.confirmId : event.permissionId,
        tool: event.tool,
        path: event.type === "destructive.confirm" ? event.command : event.path,
        reason: event.reason,
      }
      composer.busy = true
      redraw()
      return
    }

    // Start thinking animation when the LLM starts generating. Without
    // this, Telegram-originated turns (where the user is NOT typing into
    // the CLI directly, so the onInputData path that sets thinkingVisible
    // never runs) show no spinner while Amanda is generating. The
    // animation runs until either a tool.start event replaces it with
    // the tool-specific animation, or a message.received event stops it.
    //
    // Note: 'model_invoke_start' is an internal runtime event that
    // does NOT appear in the AgentEvent IPC type (see protocol.ts).
    // The previous check on event.type === "model_invoke_start" could
    // never match, which is why the thinking spinner was never shown
    // for Telegram-originated turns. The spinner is now started on
    // 'message.received' (user role) below and stopped on
    // 'message.received' (assistant role).

    // Start animation on tool.start
    if (event.type === "tool.start") {
      const line = renderToolStart(event.tool, event.input)
      const baseText = renderToolStartText(line, "└─ ")
      composer.toolThinkingText = baseText
      composer.toolThinkingFrame = 0
      startThinkingAnimation()
    }

    // Stop animation on tool.finish
    if (event.type === "tool.finish") {
      composer.toolThinkingText = ""
      composer.toolThinkingFrame = 0
    }

    // On ralph.attempt: clear any stale tool spinner and keep the
    // Thinking... indicator alive so the user sees the agent is retrying.
    if (event.type === "ralph.attempt") {
      composer.toolThinkingText = ""
      composer.toolThinkingFrame = 0
      composer.thinkingVisible = true
      startThinkingAnimation()
    }

    // Intercept MenuSchemaEnvelope from tool output — activate master dashboard
    if (event.type === "tool.finish" && event.ok && isMenuSchemaEnvelope(event.output)) {
      const { result, state } = openMasterDashboard(event.output)
      composer.masterMenuState = state
      composer.masterMenuEphemeral = true
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: "config", tone: result.tone, text: result.output },
      ])
      if (pinnedToBottom) transcript.scrollOffset = 0
      redraw()
      return
    }

    if (event.type === "model.thinking") {
      composer.accumulatedThinking = (composer.accumulatedThinking ?? "") + event.text
      redraw()
      return
    }
    if (event.type === "model.stream") {
      return
    }

    const blocks = formatter.render(event)
    if (event.type === "message.received" && event.role === "user") {
      // Show the Thinking... spinner the MOMENT a user message arrives
      // (regardless of source: CLI-typed, Telegram-delivered, /slash
      // command, etc.). Without this, there is a window between the
      // user message arrival and the runtime emitting model_invoke_start
      // during which the CLI shows nothing — the user sees silence and
      // assumes the system is hung. CLI-typed input has a similar
      // pre-event window (between Enter pressed and the daemon
      // echoing back the model_invoke_start event) but it is shorter
      // because processMessage() sets busy=true synchronously. Setting
      // busy/thinkingVisible here covers Telegram-originated turns,
      // /slash command echoes, and any other non-CLI path.
      if (!composer.permissionPrompt) {
        composer.busy = true
        composer.thinkingVisible = true
        composer.toolThinkingText = ""
        composer.accumulatedThinking = ""
        startThinkingAnimation()
        redraw()
      }
    }
    if (event.type === "message.received" && event.role === "assistant") {
      composer.thinkingVisible = false
      composer.accumulatedThinking = ""
      if (composer.masterMenuEphemeral) {
        composer.masterMenuState = null
        composer.masterMenuEphemeral = false
      }
    }
    // Defensive: when the session transitions back to idle or error, the
    // turn is over regardless of whether a `message.received(assistant)`
    // event fired (e.g. when the runtime suppressed the empty response,
    // or when the user sent a slash command that short-circuits the model
    // loop). Without this, the Thinking. spinner can stay forever — the
    // 2026-06-09 incident left the user staring at a stale spinner after
    // the Ralph Gate exhausted 20 attempts and the runtime suppressed
    // the assistant reply.
    if (event.type === "state.changed" && (event.state === "idle" || event.state === "error")) {
      composer.busy = false
      composer.thinkingVisible = false
      composer.toolThinkingText = ""
      composer.toolThinkingFrame = 0
      composer.accumulatedThinking = ""
      stopThinkingAnimation()
    }
    transcript = appendTranscriptBlocks(transcript, blocks)
    if (pinnedToBottom) transcript.scrollOffset = 0
    redraw()
  })
  const detachConnectionListener = client.onConnectionChange(connected => {
    if (connectionHealthy === connected) return
    connectionHealthy = connected
    if (!connected) subscribedSessionId = null
    redraw()
  })

  const syncTranscriptFromSession = async (session: SessionRecord) => {
    type TimedBlock = { at: string; block: TranscriptBlock }
    const sessionStart = session.createdAt

    // CLI session messages with timestamps
    const cliTimed: TimedBlock[] = []
    for (const message of session.messages) {
      if (message.role === "assistant" && isInternalToolEnvelope(message.text)) continue
      if (message.role === "user" || message.role === "assistant") {
        cliTimed.push({
          at: message.at,
          block: {
            type: "message",
            role: message.role,
            text: unwrapChannelMessage(message.text),
            ...(message.thinking ? { thinking: message.thinking } : {}),
          }
        })
      } else {
        cliTimed.push({ at: message.at, block: { type: "event", label: "system", tone: "neutral", text: message.text } })
      }
    }

    // Load tool execution worklog entries
    const toolTimed: TimedBlock[] = []
    if (session.worklog) {
      for (const entry of session.worklog) {
        if (entry.type === "tool") {
          const isStart = entry.summary.includes("started:")
          const isFinish = entry.summary.includes("finished successfully:") || entry.summary.includes("finished:")
          const isError = entry.summary.includes("failed:") || entry.summary.includes("error:")
          const tone = isError ? "error" : (isStart ? "info" : "success")
          
          let text = entry.summary
          const prefixMatch = entry.summary.match(/^Tool \w+ (?:started|finished successfully|finished|failed|blocked): ([\s\S]*)$/)
          if (prefixMatch && prefixMatch[1]) {
            text = prefixMatch[1]
          }
          
          toolTimed.push({
            at: entry.at,
            block: {
              type: "event",
              label: "tool",
              tone,
              text,
            },
          })
        }
      }
    }

    // Load telegram messages that happened during this CLI session
    let telegramTimed: TimedBlock[] = []
    try {
      const allSessions = await client.listSessions() as SessionSummary[]
      const telegramSessions = allSessions.filter(s => s.id.startsWith("telegram-"))
      for (const tgSummary of telegramSessions) {
        const chatId = tgSummary.id.slice("telegram-".length)
        const tgSession = await client.getSession(tgSummary.id) as SessionRecord | null
        if (!tgSession || tgSession.messages.length === 0) continue
        for (const message of tgSession.messages) {
          if (message.at < sessionStart) continue
          if (message.role === "assistant" && isInternalToolEnvelope(message.text)) continue
          const taskNotification = parseTaskNotification(message.text)
          if (taskNotification) {
            const tone = taskNotification.status === "completed" ? "success"
              : taskNotification.status === "failed" || taskNotification.status === "killed" ? "error"
              : "info" as const
            telegramTimed.push({ at: message.at, block: {
              type: "event", label: "telegram", tone,
              text: `telegram ${chatId} agent: ${taskNotification.summary ?? "Agent update"}`,
            } satisfies TranscriptBlock })
          } else if (message.role === "user") {
            telegramTimed.push({ at: message.at, block: {
              type: "event", label: "telegram", tone: "info",
              text: `telegram ${chatId}: ${unwrapChannelMessage(message.text)}`,
            } satisfies TranscriptBlock })
          } else if (message.role === "assistant") {
            telegramTimed.push({ at: message.at, block: {
              type: "event", label: "telegram", tone: "success",
              text: `telegram ${chatId} response: ${message.text}`,
            } satisfies TranscriptBlock })
          }
        }
      }
    } catch {
      // Non-fatal: telegram history is supplementary
    }

    // Merge by timestamp
    const merged = [...cliTimed, ...telegramTimed, ...toolTimed].sort((a, b) => a.at.localeCompare(b.at))
    transcript = {
      blocks: merged.map(m => m.block).slice(-MAX_TRANSCRIPT_BLOCKS),
      scrollOffset: transcript.scrollOffset,
    }
  }

  const ensureConnectedSession = async () => {
    const session = await ensureCliSession(client, activeSessionId === "offline" ? sessionId : activeSessionId)
    const sessionChanged = activeSessionId !== session.id
    activeSessionId = session.id
    if (subscribedSessionId !== "*") {
      await client.subscribe("*")
      subscribedSessionId = "*"
    }
    if (sessionChanged || transcript.blocks.length === 0) {
      await syncTranscriptFromSession(session)
    }
    connectionHealthy = client.isConnected()
    refreshHeader()
    return session
  }

  const maybeStartBootstrap = async (session: SessionRecord, options?: { isFreshSession?: boolean }) => {
    if (!isBootstrapSessionCandidate(session)) return false
    const profileId = (session as SessionRecord & { profileId?: string }).profileId ?? "default"
    const workspaceContext = getWorkspaceContext(rootDir, profileId, { isMainSession: true })
    if (!workspaceContext.bootstrapPending) return false
    if (!hasConfiguredModel()) {
      const result = openMissingModelMenu()
      composer.menuState = result.nextState
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: "model", tone: result.tone, text: result.output },
      ])
      redraw()
      return false
    }

    composer.busy = true
    composer.thinkingVisible = true
    startThinkingAnimation()
    redraw()
    try {
      const completion = waitForTurnCompletion(client, session.id)
      await client.startupSession(session.id, getBootstrapStartupPrompt(options?.isFreshSession ?? true))
      await completion
      return true
    } finally {
      composer.busy = false
      stopThinkingAnimation()
      refreshHeader()
      redraw()
    }
  }

  const monitorCodeRevision = async () => {
    if (revisionCheckInFlight || shouldRelaunchCli) return
    revisionCheckInFlight = true
    try {
      const currentRevision = await runGit(rootDir, ["rev-parse", "--short", "HEAD"]).catch(() => "")
      if (!currentRevision) return
      if (!loadedRevision) {
        loadedRevision = currentRevision
        return
      }
      if (currentRevision !== loadedRevision) {
        loadedRevision = currentRevision
        shouldRelaunchCli = true
        relaunchSessionId = activeSessionId !== "offline" ? activeSessionId : undefined
        transcript = appendTranscriptBlocks(transcript, [
          {
            type: "event",
            label: "update",
            tone: "info",
            text: `Detected code update to ${currentRevision}. Reloading interactive CLI...`,
          },
        ])
        redraw()
        setTimeout(() => {
          finish?.()
        }, 250)
      }
    } finally {
      revisionCheckInFlight = false
    }
  }

  const monitorConnection = async () => {
    const previousConnection = connectionHealthy
    const previousSessionId = activeSessionId
    let shouldRedraw = false
    try {
      await client.ping()
      connectionHealthy = true
      if (activeSessionId === "offline" || !subscribedSessionId) {
        const session = await ensureConnectedSession()
        if (transcript.blocks.length === 0) await syncTranscriptFromSession(session)
      }
    } catch {
      connectionHealthy = false
    } finally {
      if (connectionHealthy !== previousConnection || activeSessionId !== previousSessionId) {
        shouldRedraw = true
      }
      if (shouldRedraw) redraw()
    }
    await monitorCodeRevision()
  }

  // Commands that control the daemon or the current session and must
  // not wait behind an in-flight user turn. When the user types one of
  // these while the composer is busy, we abort the in-flight turn so
  // the control command can run as soon as the daemon releases the
  // session. Read-only commands (/help, /status, /sessions, /doctor,
  // /config) are deliberately NOT in this set — they can wait.
  //
  // The set and the predicate live in a sibling module so the
  // predicate is testable in isolation. Keep the set in sync with
  // the slash commands listed in src/apps/cli/tui/autocomplete.ts
  // and the special-cases in submitCurrentInput.

  async function tryLocalCommand(client: DaemonClient, line: string): Promise<FormattedBlock | null> {
    const trimmed = line.trim()
    if (!trimmed.startsWith("/")) return null

    const [cmd, ...args] = trimmed.split(/\s+/)

    try {
      if (cmd === "/help") return formatHelp()
      if (cmd === "/sessions") {
        const sessions = await client.listSessions() as SessionSummary[]
        return formatSessionsTable(sessions)
      }
      if (cmd === "/doctor") return formatDoctor(await client.queryDoctor() as string)
      if (cmd === "/status") return { type: "list", tone: "info", content: await client.runDaemonCommand("/status") }
      if (cmd === "/minimax" && args[0] === "remains") {
        refreshMinimaxBalance()
        // Give the async fetch a moment to complete, then read the cache
        await new Promise(r => setTimeout(r, 500))
        const state = getHeaderState(rootDir, "", false)
        const balance = state.minimaxBalance || "No se pudo obtener el saldo (¿API key configurada?)"
        return { type: "list", tone: "info", content: `MiniMax remains: ${balance}` }
      }
      if (cmd === "/update") {
        const branch = await runGit(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"])
        if (!branch) {
          return { type: "text", tone: "error", content: "Update failed: could not determine current git branch." }
        }
        const remoteUrl = await runGit(rootDir, ["remote", "get-url", "origin"]).catch(() => "")
        if (!remoteUrl) {
          return { type: "text", tone: "error", content: "Update failed: no git remote named 'origin' is configured." }
        }
        const currentHead = await runGit(rootDir, ["rev-parse", "HEAD"])
        await runGit(rootDir, ["fetch", "--prune", "origin", branch])
        const remoteHead = await runGit(rootDir, ["rev-parse", `origin/${branch}`]).catch(() => "")
        if (!remoteHead) {
          return { type: "text", tone: "error", content: `Update failed: origin/${branch} was not found after fetch.` }
        }
        const stashLabel = await stashLocalChangesForUpdate(rootDir)
        const backupBranch = currentHead !== remoteHead
          ? await backupCurrentHead(rootDir, branch, currentHead)
          : ""

        await runGit(rootDir, ["reset", "--hard", `origin/${branch}`])
        await runGit(rootDir, ["clean", "-fd"])
        // Reinstall deps: the new git tree may have added/removed/changed
        // packages in package.json. `git clean -fd` does not touch
        // node_modules (gitignored), so the previous install persists
        // unless we refresh it. Without this, the freshly-spawned daemon
        // can crash on missing imports and the restart verification polls
        // out at 15s.
        await execFileAsync("npm", ["install", "--include=dev"], {
          cwd: rootDir,
          timeout: 120_000,
          env: { ...process.env, NODE_ENV: "development" },
        })
        await restartDaemon(client, rootDir)
        connectionHealthy = client.isConnected()
        subscribedSessionId = null
        const nextHead = await runGit(rootDir, ["rev-parse", "--short", "HEAD"])
        shouldRelaunchCli = true
        relaunchSessionId = activeSessionId !== "offline" ? activeSessionId : undefined
        return {
          type: "text",
          tone: "success",
          content: [
            `Synchronized successfully with origin/${branch}.`,
            `Remote: ${remoteUrl}`,
            `Current revision: ${nextHead}`,
            backupBranch ? `Previous local HEAD was backed up to branch: ${backupBranch}` : "",
            stashLabel ? `Local uncommitted changes were backed up automatically to stash: ${stashLabel}` : "",
            "Daemon restart verified.",
            "Restarting the interactive CLI to load updated commands and menus...",
          ].filter(Boolean).join("\n"),
        }
      }
      if (cmd === "/config") {
        const [subcmd, field, ...valueParts] = args
        return formatConfig(await client.queryConfig(subcmd, field, valueParts.join(" ")) as string)
      }
    } catch {}

    return null
  }

  const cleanup = () => {
    if (closed) return
    closed = true
    stdin.off("data", onInputData)
    stdout.off("resize", onResize)
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
    if (monitorTimer) clearInterval(monitorTimer)
    stopThinkingAnimation()
    detachRenderer()
    detachConnectionListener()
    client.close()
    stdout.write(`${ANSI.showCursor}${ANSI.altScreenOff}`)
  }

  const relaunchInteractiveCli = () => {
    const cliPath = `${rootDir}/src/apps/cli.ts`
    const args = ["--experimental-strip-types", cliPath]
    if (relaunchSessionId) args.push("resume", relaunchSessionId)
    try {
      spawn(process.execPath, args, {
        cwd: rootDir,
        stdio: "inherit",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stdout.write(`\nFailed to relaunch CLI automatically: ${message}\n`)
    }
  }

  const submitCurrentInput = async () => {
    const rawLine = composer.input
    const line = rawLine.trim()
    const allowEmptyInput =
      Boolean(composer.masterMenuState) ||
      Boolean(composer.menuState) ||
      Boolean(composer.channelMenuState) ||
      Boolean(composer.websearchMenuState)
    if (!line && !allowEmptyInput) return
    composer.suggestions = []
    transcript.scrollOffset = 0

    // --- Master Dashboard menu mode ---
    if (composer.masterMenuState) {
      composer.input = ""
      composer.cursor = 0
      if (rawLine.length > 0) {
        transcript = appendTranscriptBlocks(transcript, [
          { type: "message", role: "user", text: rawLine },
        ])
      }
      const { result, state } = await processMasterMenuInput(rawLine, composer.masterMenuState)
      composer.masterMenuState = state
      if (!state) composer.masterMenuEphemeral = false
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: "config", tone: result.tone, text: result.output },
      ])
      if (result.restartDaemon) {
        transcript = appendTranscriptBlocks(transcript, [
          { type: "event", label: "daemon", tone: "info", text: "Restarting daemon to apply configuration..." },
        ])
        redraw()
        try {
          await restartDaemon(client, rootDir)
          connectionHealthy = client.isConnected()
          subscribedSessionId = null
          transcript = appendTranscriptBlocks(transcript, [
            { type: "event", label: "daemon", tone: "success", text: "Daemon restarted successfully." },
          ])
        } catch (error) {
          connectionHealthy = client.isConnected()
          transcript = appendTranscriptBlocks(transcript, [
            { type: "event", label: "daemon", tone: "error", text: `Failed to restart daemon: ${error instanceof Error ? error.message : String(error)}` },
          ])
        }
      }
      if (result.refreshHeader) refreshHeader()
      redraw()
      return
    }

    // --- Interactive menu mode ---
    if (composer.menuState) {
      composer.input = ""
      composer.cursor = 0
      if (rawLine.length > 0) {
        transcript = appendTranscriptBlocks(transcript, [
          { type: "message", role: "user", text: rawLine },
        ])
      }
      const result = await processMenuInput(rawLine, composer.menuState)
      composer.menuState = result.nextState
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: result.nextState ? "model" : "model", tone: result.tone, text: result.output },
      ])
      if (result.refreshHeader) refreshHeader()
      redraw()
      return
    }

    if (composer.channelMenuState) {
      composer.input = ""
      composer.cursor = 0
      if (rawLine.length > 0) {
        transcript = appendTranscriptBlocks(transcript, [
          { type: "message", role: "user", text: rawLine },
        ])
      }
      const result = await processChannelMenuInput(rawLine, composer.channelMenuState)
      composer.channelMenuState = result.nextState
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: result.nextState ? "channels" : "channels", tone: result.tone, text: result.output },
      ])
      if (result.restartDaemon) {
        transcript = appendTranscriptBlocks(transcript, [
          { type: "event", label: "daemon", tone: "info", text: "Restarting daemon to apply Telegram configuration..." },
        ])
        redraw()
        try {
          await restartDaemon(client, rootDir)
          connectionHealthy = client.isConnected()
          subscribedSessionId = null
          transcript = appendTranscriptBlocks(transcript, [
            { type: "event", label: "daemon", tone: "success", text: "Daemon restarted successfully." },
          ])
        } catch (error) {
          connectionHealthy = client.isConnected()
          transcript = appendTranscriptBlocks(transcript, [
            { type: "event", label: "daemon", tone: "error", text: `Failed to restart daemon: ${error instanceof Error ? error.message : String(error)}` },
          ])
        }
      }
      if (result.refreshHeader) refreshHeader()
      redraw()
      return
    }

    if (composer.websearchMenuState) {
      composer.input = ""
      composer.cursor = 0
      if (rawLine.length > 0) {
        transcript = appendTranscriptBlocks(transcript, [
          { type: "message", role: "user", text: rawLine },
        ])
      }
      const result = await processWebSearchMenuInput(rawLine, composer.websearchMenuState)
      composer.websearchMenuState = result.nextState
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: "websearch", tone: result.tone, text: result.output },
      ])
      redraw()
      return
    }

    // /websearch opens the interactive web search menu
    if (line === "/websearch") {
      composer.input = ""
      composer.cursor = 0
      const result = await openWebSearchMenu()
      composer.websearchMenuState = result.nextState
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: "websearch", tone: result.tone, text: result.output },
      ])
      redraw()
      return
    }

    // /dashboard opens the Master Configuration Hub
    if (line === "/dashboard") {
      composer.input = ""
      composer.cursor = 0
      const envelope = buildMasterDashboard()
      const { result, state } = openMasterDashboard(envelope)
      composer.masterMenuState = state
      composer.masterMenuEphemeral = false
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: "config", tone: result.tone, text: result.output },
      ])
      redraw()
      return
    }

    // /model opens the interactive model menu
    if (line === "/model") {
      composer.input = ""
      composer.cursor = 0

      const result = openModelMenu()
      composer.menuState = result.nextState
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: "model", tone: result.tone, text: result.output },
      ])
      redraw()
      return
    }

    // /channels opens the interactive channels menu
    if (line === "/channels") {
      composer.input = ""
      composer.cursor = 0
      const result = openChannelMenu()
      composer.channelMenuState = result.nextState
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: "channels", tone: result.tone, text: result.output },
      ])
      redraw()
      return
    }

    // "/" alone shows command list
    if (line === "/") {
      const [commands] = completer("/")
      const lines = ["Available commands:"]
      lines.push(...commands.map(c => `  ${c}`))
      lines.push("Type a command and press Enter, or Tab to autocomplete.")
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: "commands", tone: "neutral", text: lines.join("\n") },
      ])
      redraw()
      composer.input = ""
      composer.cursor = 0
      return
    }

    // Try local command execution first.
    // Clear input and show a spinner immediately so the user gets feedback
    // that the command was sent. Local commands can take seconds to minutes
    // (e.g. /update runs git fetch + npm install + daemon restart), and
    // without this the input box stays frozen showing the command text.
    composer.input = ""
    composer.cursor = 0
    composer.busy = true
    composer.thinkingVisible = true
    startThinkingAnimation()
    redraw()
    const localResult = await tryLocalCommand(client, line)
    if (localResult !== null) {
      commitPromptHistory(rootDir, history, line)
      composer.busy = false
      stopThinkingAnimation()
      const block = localResult
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: "command", tone: block.tone ?? "neutral", text: block.content },
      ])
      redraw()
      if (shouldRelaunchCli) {
        setTimeout(() => {
          finish?.()
        }, 250)
      }
      return
    }

    commitPromptHistory(rootDir, history, line)
    composer.input = ""
    composer.cursor = 0
    if (line === "/new") {
      // Create a fresh session — agent reloads deterministic BOOT context and starts from scratch
      transcript = { blocks: [], scrollOffset: 0 }
      needsClear = true
      try {
        await client.clearSession(activeSessionId)
        const newSession = await client.ensureSession(activeSessionId) as SessionRecord
        if (subscribedSessionId !== "*") {
          await client.subscribe("*")
          subscribedSessionId = "*"
        }
        await syncTranscriptFromSession(newSession)
        transcript = appendTranscriptBlocks(transcript, [
          { type: "event", label: "session", tone: "success", text: `Session cleared: ${activeSessionId}` },
        ])
        refreshHeader()
        redraw()
        const modelConfigured = hasConfiguredModel()
        const startedBootstrap = modelConfigured
          ? await maybeStartBootstrap(newSession, { isFreshSession: true })
          : false
        if (!startedBootstrap) {
          if (!modelConfigured) {
            const result = openMissingModelMenu()
            composer.menuState = result.nextState
            transcript = appendTranscriptBlocks(transcript, [
              { type: "event", label: "model", tone: result.tone, text: result.output },
            ])
            redraw()
            return
          }
          // Send a startup prompt so the agent reuses injected BOOT context and greets
          composer.busy = true
          composer.thinkingVisible = true
          startThinkingAnimation()
          redraw()
          const completion = waitForTurnCompletion(client, activeSessionId)
          await client.startupSession(activeSessionId, "A new session was started via /new. Run your Session Startup sequence using the injected BOOT context already present in this turn before responding. Then greet the user in your configured persona. Keep it to 1-3 sentences. Do not mention internal steps, tools, or reasoning.")
          await completion
        }
      } catch {
        transcript = appendTranscriptBlocks(transcript, [
          { type: "event", label: "error", tone: "error", text: "Failed to create new session" },
        ])
      } finally {
        composer.busy = false
        stopThinkingAnimation()
        refreshHeader()
      }
      redraw()
      return
    }
    if (line === "/exit" || line === "/quit") {
      finish?.()
      return
    }
    if (line === "/stop") {
      try {
        await client.stopDaemon()
      } catch {}
      finish?.()
      return
    }
    if (line === "/reset") {
      transcript = { blocks: [], scrollOffset: 0 }
      needsClear = true
      redraw()
    }
    composer.busy = true
    composer.thinkingFrame = 0
    composer.thinkingVisible = true
    composer.accumulatedThinking = ""
    startThinkingAnimation()
    redraw()
    try {
      await ensureConnectedSession()
      if (activeSessionId === "offline") throw new Error("daemon disconnected")
      const completion = waitForTurnCompletion(client, activeSessionId)
      await client.sendMessage(activeSessionId, line)
      await completion
    } catch (error) {
      const typed = error as CliSessionError
      connectionHealthy = client.isConnected()
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: "local error", tone: "error", text: typed.message || "Unknown error" },
      ])
    } finally {
      composer.busy = false
      stopThinkingAnimation()
      refreshHeader()
      redraw()

      if (queuedPrompt) {
        composer.input = queuedPrompt
        queuedPrompt = null
        setTimeout(() => { void submitCurrentInput() }, 0)
      }
    }
  }

  const exitActiveMenu = () => {
    if (composer.menuState || composer.channelMenuState || composer.websearchMenuState) {
      composer.menuState = null
      composer.channelMenuState = null
      composer.websearchMenuState = null
      transcript = appendTranscriptBlocks(transcript, [
        { type: "event", label: "menu", tone: "info", text: "Interactive menu cancelled." },
      ])
      redraw()
      return true
    }
    return false
  }

  const handleTabCompletion = () => {
    const [matches, token] = completer(composer.input.slice(0, composer.cursor))
    if (matches.length === 0) {
      composer.suggestions = []
      return
    }
    if (matches.length === 1) {
      const next = applyCompletion(composer.input, composer.cursor, token, matches[0] ?? token)
      composer.input = next.input
      composer.cursor = next.cursor
      composer.suggestions = []
      return
    }
    const prefix = findCommonPrefix(matches)
    if (prefix && prefix.length > token.length) {
      const next = applyCompletion(composer.input, composer.cursor, token, prefix)
      composer.input = next.input
      composer.cursor = next.cursor
    }
    composer.suggestions = matches
  }

  const lineScrollDelta = () => 1
  const pageScrollDelta = () => Math.max(1, Math.floor((stdout.rows || 24) / 2))
  const maxTranscriptScroll = () => {
    const cols = stdout.columns || 80
    const transcriptRows = getTranscriptVisibleRows(header, composer)
    const totalRows = flattenTranscript(transcript.blocks, cols).length
    return Math.max(0, totalRows - transcriptRows)
  }
  const scrollTranscript = (delta: number) => {
    const cols = stdout.columns || 80
    const transcriptRows = getTranscriptVisibleRows(header, composer)
    const totalRows = flattenTranscript(transcript.blocks, cols).length
    transcript.scrollOffset = clampScrollOffset(transcript.scrollOffset + delta, totalRows, transcriptRows)
  }
  const scrollTranscriptToTop = () => {
    transcript.scrollOffset = maxTranscriptScroll()
  }
  const scrollTranscriptToBottom = () => {
    transcript.scrollOffset = 0
  }
  const onResize = () => {
    needsClear = true
    redraw()
  }
  const onInputData = (chunk: Buffer | string) => {
    const rawChunk = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    inputBuffer += rawChunk

    if (composer.permissionPrompt) {
      const prompt = composer.permissionPrompt
      while (inputBuffer.length > 0) {
        const char = inputBuffer[0]!.toLowerCase()
        inputBuffer = inputBuffer.slice(1)
        
        if (char === "a" || char === "y") {
          composer.permissionPrompt = null
          composer.busy = false
          void client.respondPermission(activeSessionId, prompt.permissionId, "ask")
          redraw()
          break
        } else if (char === "s") {
          composer.permissionPrompt = null
          composer.busy = false
          void client.respondPermission(activeSessionId, prompt.permissionId, "allow")
          redraw()
          break
        } else if (char === "d" || char === "n" || char === "\u0003") {
          composer.permissionPrompt = null
          composer.busy = false
          void client.respondPermission(activeSessionId, prompt.permissionId, "deny")
          redraw()
          break
        }
      }
      return
    }

    const controlMap: Record<string, () => void> = {
      "\u0001": () => {
        composer.cursor = 0
        composer.suggestions = []
      },
      "\u0005": () => {
        composer.cursor = composer.input.length
        composer.suggestions = []
      },
      "\u0010": () => {
        composer.input = historyUp(history, composer.input)
        composer.cursor = composer.input.length
        composer.suggestions = []
      },
      "\u000e": () => {
        composer.input = historyDown(history)
        composer.cursor = composer.input.length
        composer.suggestions = []
      },
      "\t": () => handleTabCompletion(),
      "\u001b[D": () => {
        composer.cursor = Math.max(0, composer.cursor - 1)
        composer.suggestions = []
      },
      "\u001b[C": () => {
        composer.cursor = Math.min(composer.input.length, composer.cursor + 1)
        composer.suggestions = []
      },
      "\u001b[A": () => scrollTranscript(lineScrollDelta()),
      "\u001b[B": () => scrollTranscript(-lineScrollDelta()),
      "\u001b[5~": () => scrollTranscript(pageScrollDelta()),
      "\u001b[6~": () => scrollTranscript(-pageScrollDelta()),
      "\u001b[H": () => scrollTranscriptToTop(),
      "\u001b[F": () => scrollTranscriptToBottom(),
      "\u001b[1~": () => scrollTranscriptToTop(),
      "\u001b[4~": () => scrollTranscriptToBottom(),
      "\u001bOH": () => scrollTranscriptToTop(),
      "\u001bOF": () => scrollTranscriptToBottom(),
      "\u001b[3~": () => {
        if (composer.cursor < composer.input.length) {
          composer.input = `${composer.input.slice(0, composer.cursor)}${composer.input.slice(composer.cursor + 1)}`
        }
        composer.suggestions = []
      },
      "\u000f": () => {
        composer.showThinkingContent = !composer.showThinkingContent
      },
    }
    let didHandle = false
    const handleControl = (raw: string) => {
      const controlHandler = controlMap[raw]
      if (!controlHandler) return false
      if (!["\u001b[A", "\u001b[B", "\u0010", "\u000e", "\u000f"].includes(raw)) {
        history.index = -1
        history.draft = composer.input
      }
      controlHandler()
      didHandle = true
      return true
    }

    while (inputBuffer.length > 0) {
      const mouseMatch = inputBuffer.match(/^\u001b\[<\d+;\d+;\d+[mM]/)
      if (mouseMatch) {
        inputBuffer = inputBuffer.slice(mouseMatch[0].length)
        const mouse = parseMouseEvent(mouseMatch[0])
        if (mouse) {
          // Preserve the terminal's native text selection behavior.
          // Wheel-driven viewport scrolling causes redraws that clear the selection
          // while the user is dragging or extending it with the mouse.
          didHandle = false
        }
        continue
      }

      if (inputBuffer.startsWith("\u001b[<")) {
        if (/^\u001b\[<\d*;?\d*;?\d*$/.test(inputBuffer)) break
        inputBuffer = inputBuffer.replace(/^\u001b\[<[^\n\r]*/, "")
        didHandle = true
        continue
      }

      const controlSequence = [
        "\u001b[5~",
        "\u001b[6~",
        "\u001b[3~",
        "\u001b[1~",
        "\u001b[4~",
        "\u001b[A",
        "\u001b[B",
        "\u001b[C",
        "\u001b[D",
        "\u001b[H",
        "\u001b[F",
        "\u001bOH",
        "\u001bOF",
      ].find(sequence => inputBuffer.startsWith(sequence))
      if (controlSequence) {
        inputBuffer = inputBuffer.slice(controlSequence.length)
        handleControl(controlSequence)
        continue
      }

      if (/^\u001b(\[|\O)[0-9;]*$/.test(inputBuffer)) break

      const char = inputBuffer[0] ?? ""
      inputBuffer = inputBuffer.slice(char.length)

      if (char === "\u001b") {
        if (exitActiveMenu()) {
          didHandle = true
          continue
        }
        if (composer.busy) {
          void client.abortSession(activeSessionId)
        } else {
          composer.input = ""
          composer.cursor = 0
          composer.suggestions = []
        }
        didHandle = true
        continue
      }

      if (char === "\u0003") {
        fail?.(new Error("Aborted with Ctrl+C"))
        return
      }
      if (char === "\r" || char === "\n") {
        if (!composer.busy) {
          void submitCurrentInput()
        } else {
          const line = composer.input.trim()
          if (line) {
            queuedPrompt = line
            composer.input = ""
            composer.cursor = 0
            transcript = appendTranscriptBlocks(transcript, [
              { type: "event", label: "queued", tone: "info", text: `Queued for later: ${line}` },
            ])
            transcript.scrollOffset = 0
            // If the queued line is a runtime control command (e.g. /update,
            // /stop, /reset), do NOT wait for the in-flight turn to finish
            // naturally. Abort it now so the control command can run as soon
            // as the daemon releases the session. Without this, /update
            // typed during a slow memory consolidation sits in the queue
            // forever (or until the daemon is killed by some other path).
            if (isRuntimeControlCommand(line)) {
              void client.abortSession(activeSessionId)
              transcript = appendTranscriptBlocks(transcript, [
                { type: "event", label: "control", tone: "info", text: `Aborting current turn to run ${line}.` },
              ])
            }
          }
        }
        didHandle = true
        continue
      }
      if (char === "\u007f") {
        if (composer.cursor > 0) {
          composer.input = `${composer.input.slice(0, composer.cursor - 1)}${composer.input.slice(composer.cursor)}`
          composer.cursor -= 1
        }
        composer.suggestions = []
        didHandle = true
        continue
      }
      if (handleControl(char)) {
        continue
      }
      if (isPrintableCharacter(char)) {
        history.index = -1
        history.draft = composer.input
        composer.input = `${composer.input.slice(0, composer.cursor)}${char}${composer.input.slice(composer.cursor)}`
        composer.cursor += char.length
        composer.suggestions = []
        didHandle = true
        continue
      }
    }

    if (didHandle) {
      redraw()
      return
    }
    if (/^[\u0020-\u007e\u00a0-\u{10ffff}]+$/u.test(inputBuffer)) {
      history.index = -1
      history.draft = composer.input
      composer.input = `${composer.input.slice(0, composer.cursor)}${inputBuffer}${composer.input.slice(composer.cursor)}`
      composer.cursor += inputBuffer.length
      composer.suggestions = []
      inputBuffer = ""
      redraw()
    }
  }

  try {
    if (!stdin.isTTY) throw new Error("Interactive mode requires a TTY")
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on("data", onInputData)
    stdout.on("resize", onResize)
    stdout.write(`${ANSI.altScrollOff}${ANSI.altScreenOn}`)
    await monitorConnection()
    if (activeSessionId !== "offline") {
      const session = await ensureConnectedSession()
      if (hasConfiguredModel()) {
        await maybeStartBootstrap(session, { isFreshSession: false })
      } else {
        const result = openMissingModelMenu()
        composer.menuState = result.nextState
        transcript = appendTranscriptBlocks(transcript, [
          { type: "event", label: "model", tone: result.tone, text: result.output },
        ])
      }
    }
    monitorTimer = setInterval(() => {
      void monitorConnection()
    }, 1500)
    redraw()
    await new Promise<void>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
  } finally {
    cleanup()
    if (shouldRelaunchCli) {
      relaunchInteractiveCli()
    }
  }
}

export async function runOneShot(client: DaemonClient, prompt: string, sessionId?: string) {
  const session = await ensureCliSession(client, sessionId)
  await client.subscribe(session.id)
  const renderer = new ToolUseRenderer()
  const unsubscribe = client.onEvent((event: AgentEvent) => {
    if (event.sessionId !== session.id) return
    const line = renderer.render(event)
    if (line) stdout.write(`${line}\n`)
  })
  try {
    const completion = waitForTurnCompletion(client, session.id)
    await client.sendMessage(session.id, prompt)
    await completion
  } finally {
    unsubscribe()
  }
}
