import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

let cachedRgPath: string | null | undefined

function cursorServerRgCandidates(): string[] {
  const home = process.env.HOME
  if (!home) return []
  const serverRoot = join(home, ".cursor-server")
  if (!existsSync(serverRoot)) return []
  const out: string[] = []
  for (const entry of readdirSync(serverRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(serverRoot, entry.name, "node_modules", "@vscode", "ripgrep", "bin", "rg")
    if (existsSync(candidate)) out.push(candidate)
  }
  return out
}

/** Resolve ripgrep binary — system install, env override, or Cursor/VS Code bundle. */
export function resolveRgBinary(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath

  const candidates: string[] = []
  if (process.env.MONOLITO_RG_PATH?.trim()) candidates.push(process.env.MONOLITO_RG_PATH.trim())
  if (process.env.RG_PATH?.trim()) candidates.push(process.env.RG_PATH.trim())

  try {
    const fromPath = execFileSync("which", ["rg"], { encoding: "utf8", env: process.env }).trim()
    if (fromPath) candidates.push(fromPath)
  } catch {
    // not on PATH
  }

  candidates.push(
    "/usr/bin/rg",
    "/usr/local/bin/rg",
    "/snap/bin/rg",
    "/usr/share/cursor/resources/app/node_modules/@vscode/ripgrep/bin/rg",
    "/usr/share/code/resources/app/node_modules/@vscode/ripgrep/bin/rg",
    ...cursorServerRgCandidates(),
  )

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      cachedRgPath = candidate
      return candidate
    }
  }

  cachedRgPath = null
  return null
}
