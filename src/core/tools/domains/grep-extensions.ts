// Grep extensions: --max-columns, mtime sort, configurable VCS exclude.
// FC parity: subset del grep upstream.

export const DEFAULT_VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]
export const MAX_COLUMNS_DEFAULT = 500

export function buildVcsExcludes(extra: string[] = []): string[] {
  return Array.from(new Set([...DEFAULT_VCS_EXCLUDES, ...extra]))
}

/** Limita el ancho de una línea. Trunca con marker si excede. */
export function clampLineWidth(line: string, maxColumns: number = MAX_COLUMNS_DEFAULT): string {
  if (line.length <= maxColumns) return line
  return line.slice(0, maxColumns) + "... [truncated]"
}

/** Splits a glob string into individual globs (comma or whitespace separated).
 *  Preserves brace patterns like `{a,b}` (does not split inside braces). */
export function splitGlobPatterns(input: string): string[] {
  const result: string[] = []
  let buf = ""
  let braceDepth = 0
  for (const ch of input) {
    if (ch === "{") braceDepth++
    if (ch === "}") braceDepth--
    if ((ch === "," || /\s/.test(ch)) && braceDepth === 0) {
      if (buf.trim()) result.push(buf.trim())
      buf = ""
      continue
    }
    buf += ch
  }
  if (buf.trim()) result.push(buf.trim())
  return result
}

/** Sort results by mtime (newest first) when supported. */
export function sortByMtime<T>(results: T[], getMtime: (item: T) => number = (i: any) => (i.mtime ?? 0)): T[] {
  return [...results].sort((a, b) => getMtime(b) - getMtime(a))
}
