import test from "node:test"
import assert from "node:assert/strict"
import { checkTurnIntegrity } from "./veracityGuard.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeConfigWing } from "../session/store.ts"

// Set isolated environment root before importing Monolito core modules
const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-integrity-test-root-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

function createRootDir() {
  const root = mkdtempSync(join(tmpdir(), "monolito-integrity-test-"))
  writeConfigWing(root, "CONF_POLICY", {
    permissions: { mode: "acceptEdits", rules: [] },
    hooks: { PreToolUse: [], PostToolUse: [], SessionStart: [], SessionEnd: [] }
  })
  return root
}

function cleanupRootDir(rootDir: string) {
  rmSync(rootDir, { recursive: true, force: true })
}

test("checkTurnIntegrity - validates both execution veracity and future commitments", async () => {
  const rootDir = createRootDir()
  try {
    // Caso 1: Asistente dice que ejecutó scp, y de hecho llamó al tool Bash.
    const mockRun1 = async () => {
      return { text: JSON.stringify({ hasBrokenPromise: false, hasFalsifiedExecution: false, reason: "" }) }
    }
    const res1 = await checkTurnIntegrity(
      rootDir,
      "Ya descargué el archivo de base de datos desde la VPS usando scp.",
      ["Bash"],
      async () => mockRun1()
    )
    assert.equal(res1.verified, true)
    assert.equal(res1.type, "none")

    // Caso 2: Asistente dice que descargó algo, pero no ejecutó herramientas (falsified_execution)
    const mockRun2 = async () => {
      return {
        text: JSON.stringify({
          hasBrokenPromise: false,
          hasFalsifiedExecution: true,
          reason: "Assistant claims to have downloaded database but did not invoke scp/Bash tools."
        })
      }
    }
    const res2 = await checkTurnIntegrity(
      rootDir,
      "Ya descargué la base de datos de la VPS en scratchpad/monolito_vps.db.",
      [],
      async () => mockRun2()
    )
    assert.equal(res2.verified, false)
    assert.equal(res2.type, "falsified_execution")
    assert.equal(res2.reason, "Assistant claims to have downloaded database but did not invoke scp/Bash tools.")

    // Caso 3: Asistente promete avisar luego pero no corre tools de background (broken_promise)
    const mockRun3 = async () => {
      return {
        text: JSON.stringify({
          hasBrokenPromise: true,
          hasFalsifiedExecution: false,
          reason: "Assistant promised to warn the user later but failed to schedule/delegate background task."
        })
      }
    }
    const res3 = await checkTurnIntegrity(
      rootDir,
      "Te aviso en 5 minutos en cuanto termine de compilar en la VPS.",
      [],
      async () => mockRun3()
    )
    assert.equal(res3.verified, false)
    assert.equal(res3.type, "broken_promise")
    assert.equal(res3.reason, "Assistant promised to warn the user later but failed to schedule/delegate background task.")

    // Caso 4: Conversación general sin reclamos ni promesas
    const mockRun4 = async () => {
      return { text: JSON.stringify({ hasBrokenPromise: false, hasFalsifiedExecution: false, reason: "" }) }
    }
    const res4 = await checkTurnIntegrity(
      rootDir,
      "La base de datos de producción reside por defecto en ~/.monolito/memory/.",
      [],
      async () => mockRun4()
    )
    assert.equal(res4.verified, true)
    assert.equal(res4.type, "none")

  } finally {
    cleanupRootDir(rootDir)
    rmSync(testMonolitoRoot, { recursive: true, force: true })
  }
})
