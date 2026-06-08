// PDF text extraction via pdftotext (si está disponible).
// FC parity: subset del PDF reader upstream.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { extname } from "node:path"

const execFileAsync = promisify(execFile)

export type PdfReadResult = {
  type: "pdf"
  text: string
  pages: number
  usedExternalTool: boolean
}

export function isPdfFile(path: string): boolean {
  return extname(path).toLowerCase() === ".pdf"
}

export async function readPdfText(path: string, pageRange?: { from: number; to: number }): Promise<PdfReadResult> {
  try {
    const args = [path]
    if (pageRange) {
      args.push("-f", String(pageRange.from))
      args.push("-l", String(pageRange.to))
    }
    const { stdout } = await execFileAsync("pdftotext", args, { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 })
    const pages = Math.max(1, (stdout.match(/\x0c/g) || []).length)
    return { type: "pdf", text: stdout, pages, usedExternalTool: true }
  } catch {
    return { type: "pdf", text: "", pages: 0, usedExternalTool: false }
  }
}
