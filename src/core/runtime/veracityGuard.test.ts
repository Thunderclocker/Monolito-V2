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
    // Note: "descargué" is now caught deterministically by FIRST_PERSON_CLAIM, so the
    // LLM auditor never runs. The check still produces the right violation type.
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
    assert.match(res2.reason ?? "", /Deterministic first-person claim|Assistant claims to have downloaded/)

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

// -----------------------------------------------------------------------------
// Deterministic pre-LLM check. The LLM auditor is never consulted in these
// cases: if we reach runBackgroundTextTask, the deterministic check failed
// to catch the falsified execution and the test should fail.
// -----------------------------------------------------------------------------

const NO_LLM = async () => {
  throw new Error("LLM auditor should not be reached when deterministic check fires")
}

test("deterministic check: catches fabricated JSON tool output with 0 tool calls", async () => {
  const rootDir = createRootDir()
  try {
    const res = await checkTurnIntegrity(
      rootDir,
      'Te lo confirmo con la salida cruda:\n```\n{"ok":true,"message_id":21147,"file_id":"AwAC"}\n```',
      [],
      NO_LLM,
    )
    assert.equal(res.verified, false)
    assert.equal(res.type, "falsified_execution")
    assert.match(res.reason ?? "", /Deterministic structural match/)
  } finally { cleanupRootDir(rootDir) }
})

test("deterministic check: catches first-person past claim in Spanish", async () => {
  const rootDir = createRootDir()
  try {
    const res = await checkTurnIntegrity(
      rootDir,
      "Lo que probé en este turno: no tengo acceso a tu Docker daemon. Si lo tuviera, ya habría contestado.",
      [],
      NO_LLM,
    )
    assert.equal(res.verified, false)
    assert.equal(res.type, "falsified_execution")
    assert.match(res.reason ?? "", /first-person claim/i)
  } finally { cleanupRootDir(rootDir) }
})

test("deterministic check: catches first-person past claim in English", async () => {
  const rootDir = createRootDir()
  try {
    const res = await checkTurnIntegrity(
      rootDir,
      "I tried running docker ps but the workspace doesn't have access to the host socket.",
      [],
      NO_LLM,
    )
    assert.equal(res.verified, false)
    assert.equal(res.type, "falsified_execution")
    assert.match(res.reason ?? "", /first-person claim/i)
  } finally { cleanupRootDir(rootDir) }
})

test("deterministic check: catches 'voy a' future intent claim with 0 tool calls", async () => {
  const rootDir = createRootDir()
  try {
    const res = await checkTurnIntegrity(
      rootDir,
      "Voy con el viernes 12 de junio, datos de AccuWeather, voz amanda_voz, formato voice note por Telegram.",
      [],
      NO_LLM,
    )
    assert.equal(res.verified, false)
    assert.equal(res.type, "falsified_execution")
    assert.match(res.reason ?? "", /first-person claim/i)
  } finally { cleanupRootDir(rootDir) }
})

test("deterministic check: catches tool name + args paren pattern", async () => {
  const rootDir = createRootDir()
  try {
    const res = await checkTurnIntegrity(
      rootDir,
      'Llamé a TelegramSendVoice({"chat_id":1515784684,"voice":"/tmp/foo.mp3"}) y la tool volvió con ok: true.',
      [],
      NO_LLM,
    )
    assert.equal(res.verified, false)
    assert.equal(res.type, "falsified_execution")
    assert.match(res.reason ?? "", /structural match/i)
  } finally { cleanupRootDir(rootDir) }
})

test("deterministic check: does NOT fire when tools were called", async () => {
  const rootDir = createRootDir()
  try {
    const res = await checkTurnIntegrity(
      rootDir,
      "Probé corriendo Bash con docker ps, mirá la salida: 'CONTAINER ID   IMAGE   ...'",
      ["Bash"],
      NO_LLM,
    )
    assert.equal(res.verified, true)
    assert.equal(res.type, "none")
  } finally { cleanupRootDir(rootDir) }
})

test("deterministic check: does NOT fire on benign prose", async () => {
  const rootDir = createRootDir()
  try {
    const res = await checkTurnIntegrity(
      rootDir,
      "La base de datos de producción reside por defecto en ~/.monolito/memory/. No toqué nada.",
      [],
      NO_LLM,
    )
    assert.equal(res.verified, true)
    assert.equal(res.type, "none")
  } finally { cleanupRootDir(rootDir) }
})
