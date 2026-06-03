import test from "node:test"
import assert from "node:assert/strict"
import { checkTurnVeracity } from "./veracityGuard.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeConfigWing } from "../session/store.ts"

// Set isolated environment root before importing Monolito core modules
const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-veracity-test-root-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

function createRootDir() {
  const root = mkdtempSync(join(tmpdir(), "monolito-veracity-test-"))
  writeConfigWing(root, "CONF_POLICY", {
    permissions: { mode: "acceptEdits", rules: [] },
    hooks: { PreToolUse: [], PostToolUse: [], SessionStart: [], SessionEnd: [] }
  })
  return root
}

function cleanupRootDir(rootDir: string) {
  rmSync(rootDir, { recursive: true, force: true })
}

test("checkTurnVeracity - validates claims against tools called in turn", async () => {
  const rootDir = createRootDir()
  try {
    // Caso 1: Asistente dice que descargó/ejecutó algo, y de hecho llamó al tool Bash.
    const mockRunBackgroundTextTask1 = async (system: string, user: string) => {
      assert.ok(system.includes("silent runtime auditor"))
      assert.ok(user.includes("Tools executed in this turn: [Bash]"))
      return { text: JSON.stringify({ claimsExecution: true, hasMismatch: false, reason: "" }) }
    }

    const result1 = await checkTurnVeracity(
      rootDir,
      "Ya descargué el archivo de base de datos desde la VPS usando scp a local.",
      ["Bash"],
      async (dir, system, user) => mockRunBackgroundTextTask1(system, user)
    )
    assert.equal(result1.verified, true)

    // Caso 2: Asistente dice que descargó algo, pero no ejecutó ninguna herramienta (hasMismatch: true)
    const mockRunBackgroundTextTask2 = async (system: string, user: string) => {
      assert.ok(user.includes("Tools executed in this turn: []"))
      return {
        text: JSON.stringify({
          claimsExecution: true,
          hasMismatch: true,
          reason: "Assistant claims to have downloaded the database but no tools were executed."
        })
      }
    }

    const result2 = await checkTurnVeracity(
      rootDir,
      "Ya descargué la base de datos de la VPS en scratchpad/monolito_vps.db.",
      [],
      async (dir, system, user) => mockRunBackgroundTextTask2(system, user)
    )
    assert.equal(result2.verified, false)
    assert.equal(result2.reason, "Assistant claims to have downloaded the database but no tools were executed.")

    // Caso 3: Asistente da una respuesta general o explicativa sin afirmaciones de ejecución
    const mockRunBackgroundTextTask3 = async (system: string, user: string) => {
      return { text: JSON.stringify({ claimsExecution: false, hasMismatch: false, reason: "" }) }
    }

    const result3 = await checkTurnVeracity(
      rootDir,
      "La base de datos local de Monolito siempre se almacena por defecto en ~/.monolito/memory/.",
      [],
      async (dir, system, user) => mockRunBackgroundTextTask3(system, user)
    )
    assert.equal(result3.verified, true)

  } finally {
    cleanupRootDir(rootDir)
    rmSync(testMonolitoRoot, { recursive: true, force: true })
  }
})
