import { join } from "node:path"
import type { ConfigWingName } from "../config/configWings.ts"
import { memoryRoot } from "./memoryPaths.ts"

export function configDir(rootDir: string): string {
  return join(memoryRoot(rootDir), "config")
}

export function configWingPath(rootDir: string, wing: ConfigWingName): string {
  return join(configDir(rootDir), `${wing}.json`)
}

export function profilesPath(rootDir: string): string {
  return join(memoryRoot(rootDir), "profiles.json")
}

export function sessionsDir(rootDir: string): string {
  return join(memoryRoot(rootDir), "sessions")
}

export function sessionDir(rootDir: string, sessionId: string): string {
  return join(sessionsDir(rootDir), sessionId)
}

export function sessionMetaPath(rootDir: string, sessionId: string): string {
  return join(sessionDir(rootDir, sessionId), "meta.json")
}

export function sessionMessagesPath(rootDir: string, sessionId: string): string {
  return join(sessionDir(rootDir, sessionId), "messages.jsonl")
}

export function sessionWorklogPath(rootDir: string, sessionId: string): string {
  return join(sessionDir(rootDir, sessionId), "worklog.jsonl")
}

export function sessionEventsPath(rootDir: string, sessionId: string): string {
  return join(sessionDir(rootDir, sessionId), "events.jsonl")
}

export function sessionTasksPath(rootDir: string, sessionId: string): string {
  return join(sessionDir(rootDir, sessionId), "tasks.json")
}

export function sessionSourcesPath(rootDir: string, sessionId: string): string {
  return join(sessionDir(rootDir, sessionId), "sources.json")
}

export function sessionPrefsPath(rootDir: string, sessionId: string): string {
  return join(sessionDir(rootDir, sessionId), "prefs.json")
}

export function stateDir(rootDir: string): string {
  return join(memoryRoot(rootDir), "state")
}

export function graphPath(rootDir: string): string {
  return join(stateDir(rootDir), "knowledge_graph.jsonl")
}

export function ralphRulesPath(rootDir: string): string {
  return join(stateDir(rootDir), "ralph_rules.json")
}

export function actionLogPath(rootDir: string): string {
  return join(stateDir(rootDir), "action_log.jsonl")
}

export function semanticToolsPath(rootDir: string): string {
  return join(stateDir(rootDir), "semantic_tools.json")
}

export function resolvedErrorsPath(rootDir: string): string {
  return join(stateDir(rootDir), "resolved_errors.json")
}

export function memoryAgentCursorPath(rootDir: string): string {
  return join(stateDir(rootDir), "memory_agent_cursor.json")
}

export function processingCursorsPath(rootDir: string): string {
  return join(stateDir(rootDir), "processing_cursors.json")
}

export function telegramDir(rootDir: string): string {
  return join(stateDir(rootDir), "telegram")
}

export function telegramUpdatesPath(rootDir: string): string {
  return join(telegramDir(rootDir), "raw_updates.jsonl")
}

export function telegramSentPhotosPath(rootDir: string): string {
  return join(telegramDir(rootDir), "sent_photos.jsonl")
}

export function telegramSentAudiosPath(rootDir: string): string {
  return join(telegramDir(rootDir), "sent_audios.jsonl")
}

export function modelConfigPath(rootDir: string): string {
  return join(stateDir(rootDir), "model_config.txt")
}
