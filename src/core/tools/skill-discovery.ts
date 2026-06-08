// Skill discovery from path: cuando Read/Edit/Write se invocan sobre un path,
// encuentra skills relevantes para ese path basado en su extensión o directorio.
// upstream parity: extraído de skills upstream.

import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, extname, join } from "node:path"
import { listDynamicSkills } from "../session/store.ts"

const SKILLS_DIRS = [
  ".claude/skills",
  ".monolito/skills",
  "skills",
]

const SKILL_PATH_PATTERNS: Array<{ pattern: RegExp; skillIds: string[] }> = [
  { pattern: /\.(ts|tsx|js|jsx)$/, skillIds: ["typescript-style", "code-review"] },
  { pattern: /\.md$/, skillIds: ["markdown-format"] },
  { pattern: /\.(json|ya?ml|toml)$/, skillIds: ["config-format"] },
  { pattern: /\.(py|ipynb)$/, skillIds: ["python-style"] },
  { pattern: /Dockerfile$|\.dockerfile$/, skillIds: ["docker"] },
  { pattern: /(^|\/)test[s]?\//, skillIds: ["test-runner"] },
  { pattern: /(^|\/)migrations?\//, skillIds: ["migrations"] },
  { pattern: /\.(sh|bash|zsh)$/, skillIds: ["bash-style"] },
  { pattern: /\.sql$/, skillIds: ["sql-style"] },
  { pattern: /(^|\/)docs?\//, skillIds: ["docs"] },
]

export type DiscoveredSkill = {
  id: string
  source: "path" | "directory" | "name"
  reason: string
}

/** Descubre skills relevantes para un path. */
export async function discoverSkillsForPath(rootDir: string, path: string): Promise<DiscoveredSkill[]> {
  const result: DiscoveredSkill[] = []
  // 1. Por extension / path pattern
  for (const { pattern, skillIds } of SKILL_PATH_PATTERNS) {
    if (pattern.test(path)) {
      for (const id of skillIds) {
        result.push({ id, source: "path", reason: `path matches ${pattern}` })
      }
    }
  }
  // 2. Por nombre de archivo (e.g. Dockerfile, .gitignore)
  const base = basename(path)
  if (base === "Dockerfile" || base === ".dockerignore") {
    result.push({ id: "docker", source: "name", reason: `filename is ${base}` })
  }
  if (base === ".gitignore" || base === ".gitattributes") {
    result.push({ id: "git-hooks", source: "name", reason: `filename is ${base}` })
  }
  // 3. Por directorio (skills en el path del archivo)
  const dir = dirname(path)
  for (const skillsDir of SKILLS_DIRS) {
    if (dir.includes(skillsDir)) {
      result.push({ id: "skills-meta", source: "directory", reason: `in ${skillsDir}` })
    }
  }
  // 4. Buscar skills dinámicos disponibles que matchean por nombre/description
  try {
    const allSkills = listDynamicSkills(rootDir)
    for (const skill of allSkills) {
      // Match by name or description keyword
      if (skill.active && (path.includes(skill.name) || skill.description.toLowerCase().split(/\s+/).some(w => w.length > 4 && path.toLowerCase().includes(w)))) {
        result.push({ id: skill.name, source: "directory", reason: `matches skill ${skill.name}` })
      }
    }
  } catch {
    // Si el store falla, skip
  }
  return result
}

/** Devuelve nombres de skills únicas (deduped). */
export function uniqueSkillIds(skills: DiscoveredSkill[]): string[] {
  return Array.from(new Set(skills.map(s => s.id)))
}
