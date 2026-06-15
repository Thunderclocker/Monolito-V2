/**
 * Git context auto-detection for enriching system prompts.
 * Provides git status, branch, recent commits at conversation start.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"

const execFileAsync = promisify(execFile)
const MAX_STATUS_CHARS = 2000
const GIT_TIMEOUT_MS = 5000

async function runGit(args: string[], cwd: string, options?: { throwOnError?: boolean }): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    return result.stdout.trim()
  } catch (error) {
    if (options?.throwOnError) throw error
    return ""
  }
}

export async function isGitRepository(rootDir: string): Promise<boolean> {
  if (existsSync(rootDir + "/.git")) return true
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], rootDir)
  return result === "true"
}

export async function getGitContext(rootDir: string): Promise<string | null> {
  const isGit = await isGitRepository(rootDir)
  if (!isGit) return null

  const [branch, defaultBranch, status, log, userName] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], rootDir),
    runGit(["config", "init.defaultBranch"], rootDir).then(b => b || "main"),
    runGit(["--no-optional-locks", "status", "--short"], rootDir),
    runGit(["--no-optional-locks", "log", "--oneline", "-n", "5"], rootDir),
    runGit(["config", "user.name"], rootDir),
  ])

  if (!branch) return null

  const truncatedStatus =
    status.length > MAX_STATUS_CHARS
      ? `${status.substring(0, MAX_STATUS_CHARS)}\n... (truncated, run "git status" for full output)`
      : status

  const lines = [
    "Git status at conversation start (snapshot, does not auto-update):",
    `Current branch: ${branch}`,
    `Main branch: ${defaultBranch}`,
  ]
  if (userName) lines.push(`Git user: ${userName}`)
  lines.push(`Status:\n${truncatedStatus || "(clean)"}`)
  if (log) lines.push(`Recent commits:\n${log}`)

  return lines.join("\n")
}

type GitContextCacheEntry = {
  headMtime: number
  indexMtime: number
  context: string | null
}

const gitContextCache = new Map<string, GitContextCacheEntry>()

function gitCacheFingerprint(rootDir: string): { headMtime: number; indexMtime: number } {
  const gitDir = join(rootDir, ".git")
  return {
    headMtime: readMtime(join(gitDir, "HEAD")),
    indexMtime: readMtime(join(gitDir, "index")),
  }
}

function readMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** Session-scoped git snapshot with mtime invalidation (free-code parity). */
export async function getGitContextCached(rootDir: string): Promise<string | null> {
  if (!existsSync(join(rootDir, ".git"))) {
    return getGitContext(rootDir)
  }
  const fingerprint = gitCacheFingerprint(rootDir)
  const cached = gitContextCache.get(rootDir)
  if (cached && cached.headMtime === fingerprint.headMtime && cached.indexMtime === fingerprint.indexMtime) {
    return cached.context
  }
  const context = await getGitContext(rootDir)
  gitContextCache.set(rootDir, { ...fingerprint, context })
  return context
}

export function invalidateGitContextCache(rootDir?: string) {
  if (rootDir) {
    gitContextCache.delete(rootDir)
    return
  }
  gitContextCache.clear()
}

export function scheduleGitContextPrefetch(rootDir: string) {
  setImmediate(() => {
    void getGitContextCached(rootDir).catch(() => {})
  })
}

export function getLocalISODate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function getDateContext(): string {
  return `Today's date is ${getLocalISODate()}.`
}
