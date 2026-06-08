// File validators for Edit/Write: settings file extra validation, similar file
// suggestion.
// upstream parity: extraído de fileEditTool upstream.

import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, extname, join } from "node:path"

const SETTINGS_FILE_NAMES = new Set([
  "settings.json",
  "settings.local.json",
  ".monolitorc.json",
  ".clauderc",
  "package.json",
  "tsconfig.json",
  ".eslintrc.json",
  ".prettierrc",
])

/** Settings file detection. */
export function isSettingsFile(path: string): boolean {
  const base = basename(path).toLowerCase()
  return SETTINGS_FILE_NAMES.has(base)
}

/** Valida que el content de un settings file es JSON válido. */
export function validateSettingsFileContent(path: string, content: string): { valid: boolean; reason?: string } {
  if (!isSettingsFile(path)) return { valid: true }
  if (extname(path) === ".json") {
    try {
      JSON.parse(content)
    } catch (e) {
      return { valid: false, reason: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  return { valid: true }
}

/** Encuentra archivos similares en el mismo directorio. */
export function findSimilarFiles(path: string, maxResults: number = 3): string[] {
  if (!existsSync(path)) return []
  const dir = dirname(path)
  if (!existsSync(dir)) return []
  const targetName = basename(path)
  const targetExt = extname(targetName)
  const targetBase = basename(targetName, targetExt)
  const results: Array<{ path: string; score: number }> = []
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (entry === targetName) continue
      const fullPath = join(dir, entry)
      let isFile = false
      try {
        isFile = statSync(fullPath).isFile()
      } catch {
        continue
      }
      if (!isFile) continue
      const ext = extname(entry)
      let score = 0
      // Misma extensión
      if (ext === targetExt) score += 2
      // Prefijo común
      if (targetBase.length >= 3 && entry.toLowerCase().startsWith(targetBase.slice(0, 3).toLowerCase())) {
        score += 1
      }
      // Levenshtein-like simple: cuenta chars comunes en orden
      let common = 0
      let lastIdx = -1
      for (const ch of targetBase.toLowerCase()) {
        const idx = entry.toLowerCase().indexOf(ch, lastIdx + 1)
        if (idx > lastIdx) {
          common++
          lastIdx = idx
        }
      }
      score += Math.floor(common / Math.max(targetBase.length, 1))
      if (score > 0) {
        results.push({ path: fullPath, score })
      }
    }
  } catch {
    return []
  }
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(r => r.path)
}

/** Suggest path under cwd if file is outside. */
export function suggestPathUnderCwd(targetPath: string, cwd: string): string {
  if (targetPath.startsWith(cwd)) return targetPath
  const base = basename(targetPath)
  return join(cwd, base)
}

export const FILE_NOT_FOUND_CWD_NOTE = "File may be outside the current working directory. Use absolute path or change cwd first."
