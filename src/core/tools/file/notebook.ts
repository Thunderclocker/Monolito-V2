// Notebook reader: parsea .ipynb (formato JSON) y devuelve cells con tipos.
// FC parity: subset del notebook reader upstream.

import { readFileSync } from "node:fs"

export type NotebookCell = {
  cell_type: "code" | "markdown" | "raw"
  source: string | string[]
  execution_count?: number | null
  outputs?: unknown[]
}

export type Notebook = {
  cells: NotebookCell[]
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
  kernel?: string
  language?: string
}

export type NotebookReadResult = {
  type: "notebook"
  cells: Array<NotebookCell & { index: number }>
  totalCells: number
  metadata: Record<string, unknown>
  kernel?: string
  language?: string
}

export function readNotebook(path: string): NotebookReadResult {
  const content = readFileSync(path, "utf8")
  const parsed = JSON.parse(content) as Notebook
  return {
    type: "notebook",
    cells: (parsed.cells || []).map((cell, index) => ({ ...cell, index })),
    totalCells: (parsed.cells || []).length,
    metadata: parsed.metadata || {},
    kernel: (parsed.metadata?.kernelspec as any)?.name,
    language: (parsed.metadata?.kernelspec as any)?.language,
  }
}

/** Concatena source de cells en un string legible. */
export function cellSourceToString(source: string | string[]): string {
  if (Array.isArray(source)) return source.join("")
  return source
}
