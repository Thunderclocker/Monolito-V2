import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { execSync } from "node:child_process"
import {
  BOOT_WING_ORDER,
  DEFAULT_BOOT_WING_CONTENT,
  type BootWingName,
  isBootWingName,
} from "../bootstrap/bootWings.ts"
import {
  bootDir,
  bootWingFilePath,
  memoryMdPath,
  memoryRoot,
  wingFromBootFilename,
} from "./memoryPaths.ts"
import type { MemoryStore } from "./types.ts"

/** Soft cap for memory.md — MemoryAgent should keep the digest under this. */
export const MEMORY_MD_MAX_BYTES = 12_000

const MEMORY_MD_HEADER = `# memory.md — Memoria curada de largo plazo

Este archivo se carga **completo** en cada turno. Mantenelo conciso: hechos durables,
preferencias y contexto de sistema. El MemoryAgent debe consolidar, deduplicar y podar
en vez de solo appendear.

`

function atomicWrite(path: string, content: string) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, "utf8")
  renameSync(tmp, path)
}

function tryGitCommit(rootDir: string, relativePaths: string[]) {
  if (process.env.MONOLITO_MEMORY_GIT === "0") return
  try {
    const memRoot = memoryRoot(rootDir)
    if (!existsSync(join(memRoot, ".git"))) {
      execSync("git init", { cwd: memRoot, stdio: "ignore" })
    }
    for (const p of relativePaths) {
      execSync(`git add ${JSON.stringify(p)}`, { cwd: memRoot, stdio: "ignore" })
    }
    execSync('git commit -m "memory: auto-save"', { cwd: memRoot, stdio: "ignore" })
  } catch {
    // Non-fatal: git may be unavailable or nothing to commit
  }
}

function parseSections(markdown: string): Array<{ title: string; tags: string; body: string; raw: string }> {
  const sections: Array<{ title: string; tags: string; body: string; raw: string }> = []
  const parts = markdown.split(/\n(?=## )/)
  for (const part of parts) {
    if (!part.trim().startsWith("## ")) continue
    const lines = part.split("\n")
    const titleLine = lines[0] ?? ""
    const title = titleLine.replace(/^##\s+/, "").trim()
    let tags = ""
    let bodyStart = 1
    if (lines[1]?.startsWith("tags:")) {
      tags = lines[1].slice(5).trim()
      bodyStart = 2
    }
    const body = lines.slice(bodyStart).join("\n").trim()
    sections.push({ title, tags, body, raw: part.trim() })
  }
  return sections
}

function renderSections(preamble: string, sections: Array<{ title: string; tags: string; body: string }>): string {
  const blocks = sections.map(s => {
    const tagLine = s.tags ? `tags: ${s.tags}\n` : ""
    return `## ${s.title}\n${tagLine}${s.body}`.trimEnd()
  })
  return `${preamble.trimEnd()}\n\n${blocks.join("\n\n")}\n`.trimEnd() + "\n"
}

function readPreamble(markdown: string): string {
  const idx = markdown.indexOf("\n## ")
  if (idx === -1) return markdown.trim()
  return markdown.slice(0, idx).trim()
}

export function createMarkdownMemoryStore(rootDir: string): MemoryStore {
  const root = memoryRoot(rootDir)

  function ensureDirs() {
    mkdirSync(bootDir(rootDir), { recursive: true })
  }

  function readFile(path: string): string | null {
    if (!existsSync(path)) return null
    return readFileSync(path, "utf8")
  }

  return {
    ensureSeeded() {
      ensureDirs()
      for (const wing of BOOT_WING_ORDER) {
        const path = bootWingFilePath(rootDir, wing)
        if (!path) continue
        if (wing === "BOOT_MEMORY") {
          if (!existsSync(path)) {
            atomicWrite(path, MEMORY_MD_HEADER)
            tryGitCommit(rootDir, ["memory.md"])
          }
          continue
        }
        if (!existsSync(path)) {
          atomicWrite(path, DEFAULT_BOOT_WING_CONTENT[wing])
        }
      }
      tryGitCommit(rootDir, ["boot"])
    },

    bootWingExists(wing: string) {
      const path = bootWingFilePath(rootDir, wing)
      return path ? existsSync(path) : false
    },

    listBootWings() {
      this.ensureSeeded()
      return [...BOOT_WING_ORDER].filter(w => this.bootWingExists(w))
    },

    readBootWing(wing: string) {
      this.ensureSeeded()
      const path = bootWingFilePath(rootDir, wing)
      if (!path) return null
      return readFile(path)
    },

    writeBootWing(wing: string, content: string, append = false) {
      this.ensureSeeded()
      const path = bootWingFilePath(rootDir, wing)
      if (!path) throw new Error(`Unknown BOOT wing: ${wing}`)
      let finalContent = content
      if (append) {
        const current = readFile(path)
        if (current) finalContent = `${current.trimEnd()}\n\n${content}`
      }
      atomicWrite(path, finalContent)
      const rel = wing === "BOOT_MEMORY" ? "memory.md" : join("boot", path.split("/boot/")[1] ?? "")
      tryGitCommit(rootDir, [rel])
    },

    loadMemoryMd() {
      this.ensureSeeded()
      return readFile(memoryMdPath(rootDir)) ?? MEMORY_MD_HEADER
    },

    writeMemoryMd(content: string) {
      if (Buffer.byteLength(content, "utf8") > MEMORY_MD_MAX_BYTES * 2) {
        throw new Error(
          `memory.md exceeds hard limit (${MEMORY_MD_MAX_BYTES * 2} bytes). ` +
            `Consolidate or move old content to archive/ before writing.`,
        )
      }
      atomicWrite(memoryMdPath(rootDir), content)
      tryGitCommit(rootDir, ["memory.md"])
    },

    upsertMemorySection(sectionTitle: string, content: string, tags?: string[]) {
      this.ensureSeeded()
      const md = this.loadMemoryMd()
      const preamble = readPreamble(md) || MEMORY_MD_HEADER.trim()
      const sections = parseSections(md)
      const normalizedTitle = sectionTitle.trim()
      const existing = sections.find(s => s.title.toLowerCase() === normalizedTitle.toLowerCase())
      if (existing && existing.body.trim() === content.trim()) {
        return { action: "skipped" as const }
      }
      const tagStr = tags?.join(", ") ?? existing?.tags ?? ""
      const updated = existing
        ? sections.map(s =>
            s.title.toLowerCase() === normalizedTitle.toLowerCase()
              ? { title: normalizedTitle, tags: tagStr, body: content.trim() }
              : { title: s.title, tags: s.tags, body: s.body },
          )
        : [...sections, { title: normalizedTitle, tags: tagStr, body: content.trim() }]
      const rendered = renderSections(preamble, updated)
      this.writeMemoryMd(rendered)
      return { action: existing ? ("updated" as const) : ("inserted" as const) }
    },

    buildCachedContextBlock() {
      this.ensureSeeded()
      const parts: string[] = [
        "<agent_memory_context>",
        "The following boot configuration and curated memory are ALWAYS authoritative.",
        "Read them before answering. Do not ask the user to confirm facts already stored here.",
        "",
      ]
      for (const wing of BOOT_WING_ORDER) {
        if (wing === "BOOT_MEMORY") continue
        const text = this.readBootWing(wing)?.trim()
        if (!text) continue
        parts.push(`### ${wing}`, text, "")
      }
      const memory = this.loadMemoryMd().trim()
      if (memory) {
        parts.push("### memory.md (long-term curated digest)", memory, "")
      }
      parts.push("</agent_memory_context>")
      return parts.join("\n")
    },
  }
}

/** List boot/*.md wings discovered on disk (for diagnostics). */
export function listBootFilesOnDisk(rootDir: string): string[] {
  const dir = bootDir(rootDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith(".md"))
    .map(f => wingFromBootFilename(f))
    .filter((w): w is BootWingName => w !== null && isBootWingName(w))
}
