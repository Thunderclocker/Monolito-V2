// Edit helpers: quote normalization, desanitization, .md line-break carve-out,
// applyEditToFile, structuredPatch output, MAX_EDIT_FILE_SIZE.
//
// upstream parity: subset del quote handling + apply de FileEditTool. No incluye
// la pipeline completa de agent-rewrite (eso queda para Fase 7 si hace falta).

import { statSync } from "node:fs"
import { extname } from "node:path"

export const MAX_EDIT_FILE_SIZE = 1 * 1024 * 1024 * 1024  // 1 GiB cap

/** Detecta si un path es .ipynb (notebook). */
export function isNotebookFile(path: string): boolean {
  return extname(path).toLowerCase() === ".ipynb"
}

/** Detecta si un path es .md (preservar line breaks). */
export function isMarkdownFile(path: string): boolean {
  const ext = extname(path).toLowerCase()
  return ext === ".md" || ext === ".markdown"
}

/** Detecta si un path es settings file (validación extra). */
export function isSettingsFile(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith("settings.json") || lower.endsWith("settings.local.json")
}

/** Normaliza quotes: si el archivo usa curly quotes (‘ ’ “ ”)
 *  y old_string/new_string vinieron con straight quotes, intenta matchear. */
export function normalizeQuotes(text: string): string {
  return text
    .replace(/‘|’/g, "'")
    .replace(/“|”/g, '"')
}

export function containsCurlyQuotes(text: string): boolean {
  return /[‘’“”]/.test(text)
}

/** Detecta si old/new son equivalentes ignorando whitespace trailing. */
export function areStringsEquivalent(a: string, b: string): boolean {
  if (a === b) return true
  return a.replace(/\s+$/g, "") === b.replace(/\s+$/g, "")
}

/** Aplica un edit: si old_string aparece 1 vez → replace, si N veces y
 *  replaceAll → replaceAll, si N veces sin replaceAll → error con
 *  matchIndex esperado. */
export function applyEditToFile(
  original: string,
  oldString: string,
  newString: string,
  options: { replaceAll?: boolean; matchIndex?: number; preserveQuoteStyle?: boolean } = {},
): { success: boolean; result?: string; matches: number; error?: string } {
  let actualOld = oldString
  let originalForMatch = original
  let useStraightQuotes = false
  if (options.preserveQuoteStyle && containsCurlyQuotes(original) && containsCurlyQuotes(oldString)) {
    // Normalize both to straight quotes for matching, then restore curly in result
    actualOld = normalizeQuotes(oldString)
    originalForMatch = normalizeQuotes(original)
    useStraightQuotes = true
  }
  const matches = countOccurrences(originalForMatch, actualOld)
  if (matches === 0) {
    return { success: false, matches: 0, error: "old_string not found" }
  }
  if (options.replaceAll) {
    const result = originalForMatch.split(actualOld).join(newString)
    return { success: true, result, matches }
  }
  if (matches > 1) {
    if (options.matchIndex === undefined) {
      return {
        success: false,
        matches,
        error: `old_string matched ${matches} times; retry with matchIndex or set replaceAll=true`,
      }
    }
    if (options.matchIndex < 0 || options.matchIndex >= matches) {
      return {
        success: false,
        matches,
        error: `matchIndex ${options.matchIndex} out of range for ${matches} matches`,
      }
    }
    // Walk through and replace only the Nth occurrence
    let i = 0
    let pos = 0
    let result = ""
    while (pos < originalForMatch.length) {
      const next = originalForMatch.indexOf(actualOld, pos)
      if (next === -1) {
        result += originalForMatch.slice(pos)
        break
      }
      result += originalForMatch.slice(pos, next)
      if (i === options.matchIndex) {
        result += newString
      } else {
        result += actualOld
      }
      i++
      pos = next + actualOld.length
    }
    return { success: true, result, matches }
  }
  // single match
  const idx = originalForMatch.indexOf(actualOld)
  const result = originalForMatch.slice(0, idx) + newString + originalForMatch.slice(idx + actualOld.length)
  void useStraightQuotes
  return { success: true, result, matches: 1 }
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

/** Genera un unified diff (estructurado) entre before y after. */
export function generateUnifiedDiff(before: string, after: string, path: string): string {
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  const lines: string[] = []
  lines.push(`--- a/${path}`)
  lines.push(`+++ b/${path}`)
  // diff simple: emitir -lines y +lines
  const maxLen = Math.max(beforeLines.length, afterLines.length)
  for (let i = 0; i < maxLen; i++) {
    const b = beforeLines[i]
    const a = afterLines[i]
    if (b === a) {
      if (b !== undefined) lines.push(` ${b}`)
    } else {
      if (b !== undefined) lines.push(`-${b}`)
      if (a !== undefined) lines.push(`+${a}`)
    }
  }
  return lines.join("\n")
}

/** Aplica un array de edits atómicamente. Si alguno falla, ninguno se aplica. */
export type MultiEdit = {
  old_string: string
  new_string: string
  replace_all?: boolean
}

export type MultiEditResult = {
  success: boolean
  result?: string
  applied: number
  error?: string
  failedAt?: number
}

export function applyMultiEditToFile(
  original: string,
  edits: MultiEdit[],
  options: { preserveQuoteStyle?: boolean } = {},
): MultiEditResult {
  // Validar todos los edits primero
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]
    if (!edit.old_string || typeof edit.old_string !== "string") {
      return { success: false, applied: 0, error: `edit[${i}]: old_string must be non-empty`, failedAt: i }
    }
  }
  // Aplicar todos los edits en una pasada, sobre copias intermedias
  let current = original
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]
    const result = applyEditToFile(current, edit.old_string, edit.new_string, {
      replaceAll: edit.replace_all,
      preserveQuoteStyle: options.preserveQuoteStyle,
    })
    if (!result.success) {
      return {
        success: false,
        applied: i,
        error: `edit[${i}]: ${result.error}`,
        failedAt: i,
      }
    }
    current = result.result!
  }
  return { success: true, result: current, applied: edits.length }
}

/** Verifica que el archivo no exceda MAX_EDIT_FILE_SIZE. */
export function checkEditSize(path: string): { ok: boolean; size: number; error?: string } {
  try {
    const stat = statSync(path)
    if (stat.size > MAX_EDIT_FILE_SIZE) {
      return {
        ok: false,
        size: stat.size,
        error: `File too large for edit: ${stat.size} bytes (max ${MAX_EDIT_FILE_SIZE})`,
      }
    }
    return { ok: true, size: stat.size }
  } catch {
    return { ok: false, size: 0, error: "File not found" }
  }
}

/** No-op detection: si old_string === new_string después de normalización. */
export function isNoOpEdit(oldString: string, newString: string): boolean {
  if (oldString === newString) return true
  return normalizeQuotes(oldString) === normalizeQuotes(newString)
}
