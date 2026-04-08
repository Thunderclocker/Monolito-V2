import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { getPaths } from "../ipc/protocol.ts"

export type WorkspaceBootstrapFile =
  | "AGENTS.md"
  | "SOUL.md"
  | "TOOLS.md"
  | "IDENTITY.md"
  | "USER.md"
  | "HEARTBEAT.md"
  | "BOOTSTRAP.md"
  | "MEMORY.md"
  | "memory.md"

export type WorkspaceBootstrapEntry = {
  name: WorkspaceBootstrapFile
  content: string
  truncated: boolean
}

export type WorkspaceBootstrapContext = {
  files: WorkspaceBootstrapEntry[]
  profileId: string
  isMainSession: boolean
  bootstrapPending: boolean
}

export const OPENCLAW_BOOTSTRAP_ORDER: WorkspaceBootstrapFile[] = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
]

const BOOTSTRAP_MAX_FILE_CHARS = 20_000
const BOOTSTRAP_TOTAL_MAX_CHARS = 150_000

function truncateContent(content: string, maxChars: number) {
  const normalized = content.trim()
  if (normalized.length <= maxChars) {
    return { content: normalized, truncated: false }
  }
  return {
    content: `${normalized.slice(0, maxChars).trimEnd()}\n\n[truncated]`,
    truncated: true,
  }
}

function readWorkspaceFile(workspaceDir: string, fileName: WorkspaceBootstrapFile, remainingChars: number) {
  if (remainingChars <= 0) return null
  const filePath = join(workspaceDir, fileName)
  if (!existsSync(filePath)) return null

  try {
    const raw = readFileSync(filePath, "utf8").trim()
    if (!raw) return null
    const maxChars = Math.max(1, Math.min(BOOTSTRAP_MAX_FILE_CHARS, remainingChars))
    const truncated = truncateContent(raw, maxChars)
    return {
      entry: {
        name: fileName,
        content: truncated.content,
        truncated: truncated.truncated,
      } satisfies WorkspaceBootstrapEntry,
      consumedChars: truncated.content.length,
    }
  } catch (error) {
    console.error(`Failed to read workspace file ${fileName}:`, error)
    return null
  }
}

function isBootstrapPending(files: WorkspaceBootstrapEntry[]) {
  const bootstrap = files.find(file => file.name === "BOOTSTRAP.md")
  if (!bootstrap) return false
  const normalized = bootstrap.content.trim().toLowerCase()
  if (!normalized) return false
  return !(
    normalized.includes("bootstrap completed") ||
    normalized.includes("bootstrap complete") ||
    normalized.includes("bootstrap resolved") ||
    normalized.includes("onboarding complete")
  )
}

/**
 * OpenClaw-style bootstrap loading:
 * - inject stable workspace files every turn
 * - cap per-file and total chars
 * - MEMORY.md is only auto-injected in the main session
 * - lowercase memory.md is used as a fallback when MEMORY.md is absent
 */
export function getWorkspaceContext(rootDir: string, profileId = "default", options?: { isMainSession?: boolean }): WorkspaceBootstrapContext {
  const paths = getPaths(rootDir, profileId)
  const isMainSession = options?.isMainSession ?? true
  const files: WorkspaceBootstrapEntry[] = []
  let remainingChars = BOOTSTRAP_TOTAL_MAX_CHARS

  for (const fileName of OPENCLAW_BOOTSTRAP_ORDER) {
    const loaded = readWorkspaceFile(paths.workspaceDir, fileName, remainingChars)
    if (!loaded) continue
    files.push(loaded.entry)
    remainingChars -= loaded.consumedChars
    if (remainingChars <= 0) break
  }

  if (isMainSession && remainingChars > 0) {
    const loadedMemory =
      readWorkspaceFile(paths.workspaceDir, "MEMORY.md", remainingChars) ??
      readWorkspaceFile(paths.workspaceDir, "memory.md", remainingChars)
    if (loadedMemory) {
      files.push(loadedMemory.entry)
      remainingChars -= loadedMemory.consumedChars
    }
  }

  return {
    files,
    profileId,
    isMainSession,
    bootstrapPending: isBootstrapPending(files),
  }
}
