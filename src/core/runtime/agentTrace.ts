import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { getPaths } from "../ipc/protocol.ts"

export type AgentTraceEvent =
  | "session.resumed"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "turn.aborted"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "agent.spawned"
  | "agent.message.sent"
  | "agent.stopped"
  | "agent.task.started"
  | "agent.task.completed"
  | "agent.task.failed"
  | "agent.notification.sent"
  | "agent.background.completed"

export type AgentTraceRecord = {
  at: string
  event: AgentTraceEvent
  sessionId: string
  agentKind: "main" | "subagent" | "telegram" | "unknown"
  profileId?: string
  parentSessionId?: string
  agentId?: string
  toolName?: string
  details?: Record<string, unknown>
}

function getAgentKind(sessionId: string): AgentTraceRecord["agentKind"] {
  if (sessionId.startsWith("agent-")) return "subagent"
  if (sessionId.startsWith("telegram-")) return "telegram"
  if (sessionId) return "main"
  return "unknown"
}

export function logAgentTrace(
  rootDir: string,
  sessionId: string,
  event: AgentTraceEvent,
  options?: {
    profileId?: string
    parentSessionId?: string
    agentId?: string
    toolName?: string
    details?: Record<string, unknown>
  },
) {
  const paths = getPaths(rootDir)
  mkdirSync(paths.logsDir, { recursive: true })
  const record: AgentTraceRecord = {
    at: new Date().toISOString(),
    event,
    sessionId,
    agentKind: getAgentKind(sessionId),
    profileId: options?.profileId,
    parentSessionId: options?.parentSessionId,
    agentId: options?.agentId,
    toolName: options?.toolName,
    details: options?.details,
  }
  appendFileSync(join(paths.logsDir, "agents.log"), `${JSON.stringify(record)}\n`)
}
