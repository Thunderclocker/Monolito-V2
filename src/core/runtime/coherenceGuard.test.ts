import test from "node:test"
import assert from "node:assert/strict"
import { checkTurnCoherence } from "./coherenceGuard.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeConfigWing } from "../session/store.ts"

// Set isolated environment root before importing Monolito core modules
const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-coherence-test-root-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

function createRootDir() {
  const root = mkdtempSync(join(tmpdir(), "monolito-coherence-test-"))
  writeConfigWing(root, "CONF_POLICY", {
    permissions: { mode: "acceptEdits", rules: [] },
    hooks: { PreToolUse: [], PostToolUse: [], SessionStart: [], SessionEnd: [] }
  })
  return root
}

function cleanupRootDir(rootDir: string) {
  rmSync(rootDir, { recursive: true, force: true })
}

test("checkTurnCoherence - autonomous execution validation", async () => {
  const rootDir = createRootDir()
  try {
    // Caso de prueba 1: El asistente es coherente (está haciendo el trabajo de forma autónoma)
    const mockRunBackgroundTextTask1 = async (system: string, user: string) => {
      assert.ok(system.includes("REGLA DE AUTONOMÍA Y EJECUCIÓN"))
      return { text: JSON.stringify({ coherent: true, reason: "" }) }
    }

    const result1 = await checkTurnCoherence(
      rootDir,
      "He ejecutado la prueba en la terminal y todo funciona bien.",
      "default",
      async (dir, system, user) => mockRunBackgroundTextTask1(system, user),
      []
    )
    assert.equal(result1.coherent, true)

    // Caso de prueba 2: El asistente es incoherente (está pidiendo al usuario que ejecute comandos)
    const mockRunBackgroundTextTask2 = async (system: string, user: string) => {
      assert.ok(system.includes("REGLA DE AUTONOMÍA Y EJECUCIÓN"))
      return {
        text: JSON.stringify({
          coherent: false,
          reason: "El asistente está delegando la ejecución del comando ssh al usuario en vez de ejecutarlo él mismo."
        })
      }
    }

    const result2 = await checkTurnCoherence(
      rootDir,
      "Por favor ejecuta 'ssh -i ~/.ssh/key ubuntu@123' en tu consola para verificar si el daemon corre.",
      "default",
      async (dir, system, user) => mockRunBackgroundTextTask2(system, user),
      []
    )
    assert.equal(result2.coherent, false)
    assert.match(result2.reason || "", /delegando/i)

  } finally {
    cleanupRootDir(rootDir)
    rmSync(testMonolitoRoot, { recursive: true, force: true })
  }
})
