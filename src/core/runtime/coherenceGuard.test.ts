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
      assert.ok(system.includes("AUTONOMY AND EXECUTION RULE"))
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
      assert.ok(system.includes("AUTONOMY AND EXECUTION RULE"))
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
    assert.ok(result2.reason && result2.reason.length > 0, "reason should be non-empty when incoherent")

  } finally {
    cleanupRootDir(rootDir)
    rmSync(testMonolitoRoot, { recursive: true, force: true })
  }
})

// -----------------------------------------------------------------------------
// Fix C (2026-06-10): detectRemoteClaimWithoutRemoteTool — the coherence
// guard's deterministic pre-check that catches tool-scope mismatches
// (e.g. model claims MiniMax result but only called local-list). Incident
// 2026-06-10T20:52:47 had 2 coherence rejections for this exact pattern.
// -----------------------------------------------------------------------------

import { detectRemoteClaimWithoutRemoteTool, isClarifyingExchange } from "./coherenceGuard.ts"

test("Fix C: detectRemoteClaimWithoutRemoteTool - rejects MiniMax claim with only local list", () => {
  const reason = detectRemoteClaimWithoutRemoteTool(
    "En MiniMax hay 0 voces remotas.",
    [{ tool: "VoiceClone", ok: true, input: { action: "list" } }],
  )
  assert.ok(reason, "must produce a reason when remote claim + only local list")
  assert.match(reason, /list_remote/)
})

test("Fix C: detectRemoteClaimWithoutRemoteTool - passes when list_remote was called", () => {
  const reason = detectRemoteClaimWithoutRemoteTool(
    "En MiniMax hay 0 voces remotas.",
    [{ tool: "VoiceClone", ok: true, input: { action: "list_remote" } }],
  )
  assert.equal(reason, null, "must NOT reject when list_remote was called")
})

test("Fix C: detectRemoteClaimWithoutRemoteTool - passes when no remote claim", () => {
  const reason = detectRemoteClaimWithoutRemoteTool(
    "Las voces locales son mapa_stargate.",
    [{ tool: "VoiceClone", ok: true, input: { action: "list" } }],
  )
  assert.equal(reason, null, "must NOT reject when the claim is about local config")
})

test("Fix C: detectRemoteClaimWithoutRemoteTool - passes when no VoiceClone was called", () => {
  const reason = detectRemoteClaimWithoutRemoteTool(
    "En MiniMax hay 0 voces remotas.",
    [{ tool: "Bash", ok: true }],
  )
  assert.equal(reason, null, "must NOT reject when the claim isn't backed by VoiceClone")
})

test("Fix C: detectRemoteClaimWithoutRemoteTool - handles English 'remote voices' claim", () => {
  const reason = detectRemoteClaimWithoutRemoteTool(
    "There are 0 remote voices in MiniMax right now.",
    [{ tool: "VoiceClone", ok: true, input: { action: "list" } }],
  )
  assert.ok(reason)
  assert.match(reason, /list_remote/)
})

test("Fix C: detectRemoteClaimWithoutRemoteTool - handles 'en el provider' (Spanish)", () => {
  const reason = detectRemoteClaimWithoutRemoteTool(
    "El provider no tiene ninguna voz clonada registrada.",
    [{ tool: "VoiceClone", ok: true, input: { action: "list" } }],
  )
  assert.ok(reason)
})

test("Fix C: detectRemoteClaimWithoutRemoteTool - mixed local+remote calls: passes", () => {
  const reason = detectRemoteClaimWithoutRemoteTool(
    "En MiniMax hay 3 voces remotas.",
    [
      { tool: "VoiceClone", ok: true, input: { action: "list" } },
      { tool: "VoiceClone", ok: true, input: { action: "list_remote" } },
    ],
  )
  assert.equal(reason, null, "when list_remote was called alongside list, the remote claim is legitimate")
})

test("isClarifyingExchange: allows short clarifying Q&A", () => {
  assert.equal(
    isClarifyingExchange(
      [{ role: "user", text: "para los dos o para cual?" }],
      "Para una sola tarea — la ventana. Te había dado dos opciones de título, no dos pendientes.",
    ),
    true,
  )
})

test("isClarifyingExchange: rejects delegation disguised as clarification", () => {
  assert.equal(
    isClarifyingExchange(
      [{ role: "user", text: "para los dos o para cual?" }],
      "Ejecutalo vos en tu consola y decime cuál opción preferís.",
    ),
    false,
  )
})
