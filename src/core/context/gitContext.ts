/**
 * Git context auto-detection for enriching system prompts.
 * Provides git status, branch, recent commits at conversation start.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { ensureMonolitoRoot } from "../system/root.ts"

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

export async function createAgentWorktree(rootDir: string, branchName: string): Promise<string> {
  const worktreeRoot = join(ensureMonolitoRoot(), "run", "worktrees")
  const worktreePath = join(worktreeRoot, branchName)
  await mkdir(worktreeRoot, { recursive: true })
  try {
    await runGit(["worktree", "add", "-b", branchName, worktreePath], rootDir, { throwOnError: true })
    if (!existsSync(worktreePath)) {
      throw new Error(`Git worktree path was not created: ${worktreePath}`)
    }
    return worktreePath
  } catch (error) {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function removeAgentWorktree(rootDir: string, worktreePath: string): Promise<void> {
  await runGit(["worktree", "remove", "-f", worktreePath], rootDir, { throwOnError: true })
}

export async function isGitRepository(rootDir: string): Promise<boolean> {
  if (existsSync(join(rootDir, ".git"))) return true
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
