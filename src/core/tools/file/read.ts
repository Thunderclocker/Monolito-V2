// Read split — core reader con streaming fast-path, dedup via readFileState,
// device-file guard, binary reject, mtime population.
//
// upstream parity: extraído de FileReadTool.ts con simplificaciones:
// - Sin image processor (queda en media.ts)
// - Sin notebook reader separado (Fase 2)
// - Sin pdftotext (Fase 2)
// - device guard y binary reject son las dos guards críticas para v1.

import { createReadStream, statSync, existsSync } from "node:fs"
import { basename, extname } from "node:path"
import { setReadFileStateForTool, fingerprint } from "../file-state.ts"

export const MAX_READ_SIZE_BYTES = 256 * 1024  // 256KB cap (M actual: sin cap)
export const DEFAULT_READ_LINE_LIMIT = 2000   // upstream parity
export const DEVICE_FILE_PATTERN = /^\/(dev|proc|sys)\//

export type ReadOutput = {
  type: "text" | "file_too_large" | "binary" | "device_file" | "not_found"
  path: string
  content?: string
  totalLines: number
  offset: number
  lineLimit?: number
  returnedLines: number
  hasMore: boolean
  bytes: number
  file_unchanged?: { hash: string }
}

/** Lee un archivo. Hace streaming fast-path para files grandes. Popula
 *  readFileState para que Edit/Write puedan hacer pre-read check. */
export async function readFile(params: {
  sessionId: string
  rootDir: string
  cwd: string
  path: string
  offset?: number
  line_limit?: number
}): Promise<ReadOutput> {
  const offset = params.offset ?? 0
  const lineLimit = params.line_limit

  if (!existsSync(params.path)) {
    return {
      type: "not_found",
      path: params.path,
      totalLines: 0,
      offset,
      lineLimit,
      returnedLines: 0,
      hasMore: false,
      bytes: 0,
    }
  }

  // Device file guard
  if (DEVICE_FILE_PATTERN.test(params.path)) {
    return {
      type: "device_file",
      path: params.path,
      totalLines: 0,
      offset,
      lineLimit,
      returnedLines: 0,
      hasMore: false,
      bytes: 0,
    }
  }

  const stat = statSync(params.path)
  const sizeBytes = stat.size
  const mtime = Math.floor(stat.mtimeMs)

  // File too large: devolver stub en vez de leer
  if (sizeBytes > MAX_READ_SIZE_BYTES) {
    const hash = fingerprint(`${sizeBytes}:${mtime}`)
    return {
      type: "file_too_large",
      path: params.path,
      totalLines: 0,
      offset,
      lineLimit,
      returnedLines: 0,
      hasMore: false,
      bytes: sizeBytes,
      file_unchanged: { hash },
    }
  }

  // Binary detection: leer primeros 8KB y buscar null bytes
  const buffer = await readWithLimit(params.path, 8 * 1024)
  if (looksLikeBinary(buffer)) {
    return {
      type: "binary",
      path: params.path,
      totalLines: 0,
      offset,
      lineLimit,
      returnedLines: 0,
      hasMore: false,
      bytes: sizeBytes,
    }
  }

  // Read completo (es chico, ya validamos < 256KB)
  const content = buffer.toString("utf8")
  const lines = content.split("\n")
  const totalLines = lines.length

  // Aplicar offset + line_limit
  const page = lineLimit === undefined
    ? lines.slice(offset)
    : lines.slice(offset, offset + lineLimit)
  const returnedLines = page.length
  const hasMore = offset + returnedLines < totalLines
  const out = page.join("\n")

  // Populate readFileState para Edit/Write pre-read checks
  setReadFileStateForTool(
    params.sessionId,
    params.rootDir,
    params.path,
    out,
    { offset, limit: lineLimit },
  )

  return {
    type: "text",
    path: params.path,
    content: out,
    totalLines,
    offset,
    lineLimit,
    returnedLines,
    hasMore,
    bytes: sizeBytes,
  }
}

async function readWithLimit(path: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let read = 0
    const stream = createReadStream(path, { end: maxBytes - 1 })
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      chunks.push(buf)
      read += buf.length
      if (read >= maxBytes) {
        stream.destroy()
      }
    })
    stream.on("close", () => resolve(Buffer.concat(chunks).slice(0, maxBytes)))
    stream.on("end", () => resolve(Buffer.concat(chunks)))
    stream.on("error", reject)
  })
}

function looksLikeBinary(buf: Buffer): boolean {
  // Heurística: si tiene NUL bytes en los primeros 8KB, es binario
  const limit = Math.min(buf.length, 8 * 1024)
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export function isNotebookFile(path: string): boolean {
  return extname(path).toLowerCase() === ".ipynb"
}

export function fileExtension(path: string): string {
  return extname(basename(path)).toLowerCase()
}
