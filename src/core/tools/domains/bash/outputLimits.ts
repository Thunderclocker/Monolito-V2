// Bash output limits: truncation marker, large output persistence.
// FC parity: extraído de BashTool.tsx output handling.

export const MAX_OUTPUT_BYTES = 64 * 1024  // 64MB cap
export const DEFAULT_TRUNCATION_LIMIT = 30_000  // 30K chars default
export const TRUNCATION_MARKER = "\n\n[... output truncated ...]\n"

export type OutputTruncation = {
  output: string
  truncated: boolean
  /** Chars que fueron removidos. */
  removedChars: number
  /** Path al archivo donde se guardó el output completo (si se persistió). */
  persistedPath?: string
}

export type TruncationOptions = {
  /** Chars max antes de truncar (default 30K). */
  limit?: number
  /** Si true y se trunca, persiste output completo a un archivo. */
  persistToFile?: boolean
  /** Directorio donde persistir (si se persiste). */
  persistDir?: string
  /** Prefijo del archivo persistido. */
  filePrefix?: string
}

import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export function truncateOutput(output: string, options: TruncationOptions = {}): OutputTruncation {
  const limit = options.limit ?? DEFAULT_TRUNCATION_LIMIT
  if (output.length <= limit) {
    return { output, truncated: false, removedChars: 0 }
  }
  const truncated = output.slice(0, limit)
  const removedChars = output.length - limit
  const result: OutputTruncation = {
    output: `${truncated}${TRUNCATION_MARKER}`,
    truncated: true,
    removedChars,
  }
  if (options.persistToFile && options.persistDir) {
    mkdirSync(options.persistDir, { recursive: true })
    const prefix = options.filePrefix ?? "bash-output"
    const filename = `${prefix}-${Date.now()}.txt`
    const fullPath = join(options.persistDir, filename)
    writeFileSync(fullPath, output, "utf8")
    result.persistedPath = fullPath
  }
  return result
}

/** Detecta si output parece binario / data URI. */
export function looksLikeImageOutput(output: string): boolean {
  if (output.length < 100) return false
  if (output.startsWith("data:image/")) return true
  // Heurística: NUL bytes en los primeros 8KB
  const limit = Math.min(output.length, 8000)
  for (let i = 0; i < limit; i++) {
    if (output.charCodeAt(i) === 0) return true
  }
  return false
}
