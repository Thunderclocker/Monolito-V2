import { randomUUID } from "node:crypto"
import { type MonolitoV2Runtime } from "./runtime.ts"
import { ensureDirs } from "../ipc/protocol.ts"
import { appendMessage, createProfile, createSession, listProfiles } from "../session/store.ts"
import { readChannelsConfig } from "../channels/config.ts"
import { createInstanceLogger, type Logger } from "../logging/logger.ts"

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

export type DelegationTask = {
  id: string
  parentSessionId: string
  subSessionId: string
  profileId: string
  type: "worker" | "researcher" | "verifier"
  mode: "interactive" | "background"
  description: string
  task: string
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
}

export type SpawnAgentResult = {
  agentId: string
  status: "spawned" | "completed" | "failed" | "killed"
  result?: string
  error?: string
}

const IMMEDIATE_AGENT_SETTLE_MS = 1_500

function getTelegramChatId(sessionId: string) {
  return sessionId.startsWith("telegram-") ? sessionId.slice("telegram-".length) : null
}

export class AgentOrchestrator {
  private activeTasks = new Map<string, DelegationTask>()
  private runtime: MonolitoV2Runtime

  constructor(runtime: MonolitoV2Runtime) {
    this.runtime = runtime
  }

  async spawnAgent(
    parentSessionId: string, 
    profileId: string, 
    task: string, 
    description?: string, 
    type: DelegationTask["type"] = "worker"
  ): Promise<SpawnAgentResult> {
    return await this.spawnTask({
      parentSessionId,
      profileId,
      task,
      description,
      type,
      mode: "interactive",
    })
  }

  async spawnBackgroundTask(
    parentSessionId: string,
    profileId: string,
    task: string,
    description?: string,
    jobGroupId?: string,
  ): Promise<SpawnAgentResult> {
    return await this.spawnTask({
      parentSessionId,
      profileId,
      task,
      description,
      type: "worker",
      mode: "background",
      jobGroupId,
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
  }): Promise<SpawnAgentResult> {
    const rootDir = this.runtime.rootDir
    const subSessionId = `agent-${options.profileId}-${randomUUID().slice(0, 8)}`

    const profiles = listProfiles(rootDir)
    if (!profiles.find(profile => profile.id === options.profileId)) {
      createProfile(rootDir, options.profileId, options.profileId, `Auto-generated profile for ${options.profileId}`)
    }
    ensureDirs(rootDir, options.profileId)
    
    // Create the session for the sub-agent
    createSession(rootDir, options.description || `Task: ${options.task.slice(0, 30)}...`, subSessionId, options.profileId)
    
    const delegationTask: DelegationTask = {
      id: subSessionId, // Use subSessionId as the taskId for simplicity and SendMessage correlation
      parentSessionId: options.parentSessionId,
      subSessionId,
      profileId: options.profileId,
      type: options.type,
      mode: options.mode,
      description: options.description || "Untitled task",
      task: options.task,
      status: "pending",
      jobGroupId: options.jobGroupId,
      logger: createInstanceLogger(subSessionId, options.type),
    }

    this.activeTasks.set(delegationTask.id, delegationTask)

    // Execute in background
    const runPromise = this.executeTurn(delegationTask, options.task).catch(err => {
      console.error(`Delegation task ${delegationTask.id} failed:`, err)
    })
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
    this.executeTurn(task, message).catch(err => {
      console.error(`Continuing agent ${agentId} failed:`, err)
    })
  }

  async stopAgent(agentId: string): Promise<void> {
    const task = this.activeTasks.get(agentId)
    if (!task) throw new Error(`Agent ${agentId} not found.`)
    
    this.runtime.abortSession(task.subSessionId)
    task.status = "killed"
    this.notifyParent(task, "Agent was stopped by coordinator.")
  }

  private async executeTurn(task: DelegationTask, text: string) {
    const turnStartedAt = Date.now()
    task.status = "running"
    const { runtime } = this
    try {
      // 1. Send the task as the starting message in the sub-session
      appendMessage(runtime.rootDir, task.subSessionId, "user", text)
      
      // 2. Run the turn
      const turn: any = await runtime.runTurn(task.subSessionId, text, task.profileId, { logger: task.logger })
      
      task.status = "completed"
      task.result = turn.finalText
      task.error = undefined
      task.usage = {
        total_tokens: turn.usage?.totalTokens ?? 0,
        tool_uses: 0, // We could count these in runtime if needed
        duration_ms: Date.now() - turnStartedAt
      }
      // 3. Notify parent session with XML
      this.notifyParent(task)
      
    } catch (error) {
      task.status = "failed"
      const errorMsg = error instanceof Error ? error.message : String(error)
      task.error = errorMsg
      this.notifyParent(task, errorMsg)
    }
  }

  private notifyParent(task: DelegationTask, error?: string) {
    if (task.mode === "background") {
      this.runtime.emit({
        type: "agent.background.completed",
        sessionId: task.parentSessionId,
        agentId: task.id,
        status: task.status === "completed" ? "completed" : task.status === "killed" ? "killed" : "failed",
        result: task.result,
        error,
      })
      void this.runtime.handleBackgroundDelegationResult(task, error)
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
    void this.deliverTelegramWorkerResult(task, error)
  }

  private async deliverTelegramWorkerResult(task: DelegationTask, error?: string) {
    const chatId = getTelegramChatId(task.parentSessionId)
    if (!chatId) return

    const config = readChannelsConfig()
    if (!config.telegram?.enabled || !config.telegram.token) return

    const text = task.status === "completed"
      ? (task.result?.trim() || `Agent "${task.description}" completed.`)
      : `Agent "${task.description}" ${task.status}${error ? `: ${error}` : "."}`

    appendMessage(this.runtime.rootDir, task.parentSessionId, "assistant", text)
    this.runtime.emit({
      type: "message.received",
      sessionId: task.parentSessionId,
      role: "assistant",
      text,
    })

    try {
      for (const chunk of chunkTelegramMessage(text)) {
        await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
        })
      }
    } catch (sendError) {
      console.error(`Failed to deliver worker result to telegram chat ${chatId}:`, sendError)
    }
  }

  listTasks() {
    return Array.from(this.activeTasks.values())
  }
}
