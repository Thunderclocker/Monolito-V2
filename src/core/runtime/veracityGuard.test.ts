import test from "node:test"
import assert from "node:assert/strict"
import { checkTurnIntegrity, parseAuditorJson, parseAuditorJsonByRegex } from "./veracityGuard.ts"
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

// -----------------------------------------------------------------------------
// LLM auditor: unverified-incapacity detection.
//
// The LLM auditor is language-agnostic: it understands "no puedo", "I can't",
// "impossible", "実行できません" as the same semantic pattern. The tests use
// the mock LLM to simulate the auditor's verdict.
// -----------------------------------------------------------------------------

test("LLM auditor: catches unverified incapacity claim in Spanish (the 18:33:49 case)", async () => {
  const rootDir = createRootDir()
  try {
    const mockLLM = async () => ({
      text: JSON.stringify({
        hasBrokenPromise: false,
        hasFalsifiedExecution: false,
        hasUnverifiedIncapacity: true,
        reason: "Assistant declared 'no puedo listártelos' without calling any tool to verify the limitation.",
      }),
    })
    const res = await checkTurnIntegrity(
      rootDir,
      "no puedo listártelos yo sola. Mis tools corren dentro del workspace de Monolito, no en tu host. No tengo endpoint al docker.sock.",
      [],
      mockLLM,
    )
    assert.equal(res.verified, false)
    assert.equal(res.type, "unverified_incapacity")
    assert.match(res.reason ?? "", /no puedo|incapacity|unverified/i)
  } finally { cleanupRootDir(rootDir) }
})

test("LLM auditor: catches unverified incapacity claim in English", async () => {
  const rootDir = createRootDir()
  try {
    const mockLLM = async () => ({
      text: JSON.stringify({
        hasBrokenPromise: false,
        hasFalsifiedExecution: false,
        hasUnverifiedIncapacity: true,
        reason: "Assistant declared 'I can't access' without trying.",
      }),
    })
    const res = await checkTurnIntegrity(
      rootDir,
      "I can't access your Docker daemon from this workspace. I have no way to list containers.",
      [],
      mockLLM,
    )
    assert.equal(res.verified, false)
    assert.equal(res.type, "unverified_incapacity")
  } finally { cleanupRootDir(rootDir) }
})

test("LLM auditor: pass-through when LLM reports no violation", async () => {
  const rootDir = createRootDir()
  try {
    const mockLLM = async () => ({
      text: JSON.stringify({
        hasBrokenPromise: false,
        hasFalsifiedExecution: false,
        hasUnverifiedIncapacity: false,
        reason: "",
      }),
    })
    // Note: text contains no first-person past claim and no fabricated tool
    // output, so the deterministic check passes through to the LLM auditor.
    const res = await checkTurnIntegrity(
      rootDir,
      "Status of the local container: socket not present. Permission model denies the request.",
      [],
      mockLLM,
    )
    assert.equal(res.verified, true)
    assert.equal(res.type, "none")
  } finally { cleanupRootDir(rootDir) }
})

// -----------------------------------------------------------------------------
// parseAuditorJson — defensive JSON parser for the LLM auditor's response.
// Regression tests for the markdown-fence bug observed in production on
// 2026-06-09: the auditor responded with ```json ... ``` and JSON.parse threw,
// producing 14+ [VERACITY_GUARD_UNVERIFIED] log lines per Ralph Loop attempt.
// -----------------------------------------------------------------------------

test("parseAuditorJson: clean JSON passes through", () => {
  const r = parseAuditorJson(
    JSON.stringify({ hasBrokenPromise: false, hasFalsifiedExecution: true, reason: "x" }),
  )
  assert.ok(r)
  assert.equal(r.hasFalsifiedExecution, true)
  assert.equal(r.hasBrokenPromise, false)
  assert.equal(r.reason, "x")
})

test("parseAuditorJson: extracts from ```json ... ``` markdown fence", () => {
  const fenced = [
    "```json",
    "{",
    '  "hasBrokenPromise": false,',
    '  "hasFalsifiedExecution": true,',
    '  "hasUnverifiedIncapacity": false,',
    '  "reason": "matched structural pattern"',
    "}",
    "```",
  ].join("\n")
  const r = parseAuditorJson(fenced)
  assert.ok(r)
  assert.equal(r.hasFalsifiedExecution, true)
  assert.equal(r.reason, "matched structural pattern")
})

test("parseAuditorJson: extracts from ``` ... ``` fence without language tag", () => {
  const r = parseAuditorJson("```\n{\"hasBrokenPromise\":true}\n```")
  assert.ok(r)
  assert.equal(r.hasBrokenPromise, true)
})

test("parseAuditorJson: ignores prose prefix/suffix around JSON object", () => {
  const r = parseAuditorJson(
    'Here is my verdict:\n{"hasBrokenPromise":false,"hasFalsifiedExecution":false,"reason":""}\nDone.',
  )
  assert.ok(r)
  assert.equal(r.hasFalsifiedExecution, false)
})

test("parseAuditorJson: returns null on pure garbage", () => {
  assert.equal(parseAuditorJson("definitely not json"), null)
  assert.equal(parseAuditorJson(""), null)
  assert.equal(parseAuditorJson("```\nsome prose without json\n```"), null)
})

test("parseAuditorJson: returns null when no boolean field is present", () => {
  // We captured a fragment of unrelated JSON (e.g. response metadata), not the verdict.
  assert.equal(parseAuditorJson('{"unrelated":"object","foo":42}'), null)
})

// -----------------------------------------------------------------------------
// Fix B (2026-06-10): execution-negation patterns. The model must not
// claim "I did not execute any tool" when the worklog shows tools ran.
// Incident: 2026-06-10T20:53:01 model said "no ejecuté ninguna tool"
// while 2 VoiceClone calls were in the worklog.
// -----------------------------------------------------------------------------

test("Fix B: rejects Spanish 'no ejecuté ninguna tool' when tools were called", async () => {
  const rootDir = createRootDir()
  try {
    const res = await checkTurnIntegrity(
      rootDir,
      "Tenés razón, me mandé una mentira. En este turno no ejecuté ninguna tool — solo te copié el formato.",
      ["VoiceClone", "VoiceClone"],
      async () => ({ text: JSON.stringify({ hasBrokenPromise: false, hasFalsifiedExecution: false, reason: "" }) }),
    )
    assert.equal(res.verified, false, "must reject execution-negation when tools ran")
    assert.equal(res.type, "falsified_execution")
    assert.match(res.reason ?? "", /denies execution but 2 tool/)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Fix B: rejects English 'I did not call any tool' when tools were called", async () => {
  const rootDir = createRootDir()
  try {
    const res = await checkTurnIntegrity(
      rootDir,
      "I should be honest: I did not execute any tool in this turn.",
      ["Bash"],
      async () => ({ text: JSON.stringify({ hasBrokenPromise: false, hasFalsifiedExecution: false, reason: "" }) }),
    )
    assert.equal(res.verified, false)
    assert.equal(res.type, "falsified_execution")
    assert.match(res.reason ?? "", /denies execution but 1 tool/)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Fix B: passes execution-negation claim when NO tools were called (legitimate)", async () => {
  const rootDir = createRootDir()
  try {
    const res = await checkTurnIntegrity(
      rootDir,
      "I did not execute any tool in this turn; I just explained the situation.",
      [],
      async () => ({ text: JSON.stringify({ hasBrokenPromise: false, hasFalsifiedExecution: false, reason: "" }) }),
    )
    assert.equal(res.verified, true, "when no tools ran, denying execution is legitimate")
  } finally {
    cleanupRootDir(rootDir)
  }
})

// -----------------------------------------------------------------------------
// Fix C (2026-06-11): Improved parseAuditorJson — handles single quotes,
// trailing commas, unquoted keys.
// -----------------------------------------------------------------------------

test("parseAuditorJson: handles single quotes instead of double quotes", () => {
  const r = parseAuditorJson(
    "{'hasBrokenPromise': false, 'hasFalsifiedExecution': true, 'reason': 'single quotes'}",
  )
  assert.ok(r)
  assert.equal(r.hasFalsifiedExecution, true)
  assert.equal(r.reason, "single quotes")
})

test("parseAuditorJson: handles trailing comma before closing brace", () => {
  const r = parseAuditorJson(
    '{"hasBrokenPromise": false, "hasFalsifiedExecution": true,}',
  )
  assert.ok(r)
  assert.equal(r.hasFalsifiedExecution, true)
})

test("parseAuditorJson: handles unquoted keys", () => {
  const r = parseAuditorJson(
    "{hasBrokenPromise: false, hasFalsifiedExecution: true, reason: 'unquoted keys'}",
  )
  assert.ok(r)
  assert.equal(r.hasFalsifiedExecution, true)
  assert.equal(r.reason, "unquoted keys")
})

// -----------------------------------------------------------------------------
// Fix D (2026-06-11): parseAuditorJsonByRegex — regex fallback when JSON is
// completely malformed (truncated, wrapped in prose, mixed formats).
// -----------------------------------------------------------------------------

test("parseAuditorJsonByRegex: extracts flags from prose", () => {
  const r = parseAuditorJsonByRegex(
    "After reviewing the response, I determine hasFalsifiedExecution=true and hasBrokenPromise=false",
  )
  assert.ok(r)
  assert.equal(r.hasFalsifiedExecution, true)
  assert.equal(r.hasBrokenPromise, false)
  assert.equal(r.hasUnverifiedIncapacity, false)
})

test("parseAuditorJsonByRegex: extracts flags from key=value format", () => {
  const r = parseAuditorJsonByRegex(
    'hasBrokenPromise=false hasFalsifiedExecution=false hasUnverifiedIncapacity=true reason="No intentó verificar nada"',
  )
  assert.ok(r)
  assert.equal(r.hasUnverifiedIncapacity, true)
})

test("parseAuditorJsonByRegex: extracts flags from truncated JSON", () => {
  const r = parseAuditorJsonByRegex(
    '{"hasBrokenPromise":false, "hasFalsifiedExecution":true, "hasUnverifiedIncapacity"',
  )
  assert.ok(r, "regex must extract flags from truncated JSON where only key names remain")
  assert.equal(r.hasFalsifiedExecution, true, "hasFalsifiedExecution=true is present before truncation")
  assert.equal(r.hasBrokenPromise, false, "hasBrokenPromise is false in the raw text")
  assert.equal(r.hasUnverifiedIncapacity, false, "hasUnverifiedIncapacity has no value (truncated)")
})

test("parseAuditorJsonByRegex: returns null when no flag is found", () => {
  assert.equal(parseAuditorJsonByRegex("esto es solo texto sin flags"), null)
  assert.equal(parseAuditorJsonByRegex(""), null)
})

test("parseAuditorJsonByRegex: extracts reason alongside flags", () => {
  const r = parseAuditorJsonByRegex(
    'hasFalsifiedExecution=true reason="The assistant claims execution without calling any tool"',
  )
  assert.ok(r)
  assert.equal(r.hasFalsifiedExecution, true)
  assert.equal(r.reason, "The assistant claims execution without calling any tool")
})

test("checkTurnIntegrity: falls back to regex when JSON is malformed but flags are present", async () => {
  const rootDir = createRootDir()
  try {
    // LLM auditor returns prose with inline flags (no valid JSON)
    const mockLLM = async () => ({
      text: "I checked: hasFalsifiedExecution=true, hasBrokenPromise=false, hasUnverifiedIncapacity=false",
    })
    const res = await checkTurnIntegrity(
      rootDir,
      "The container status shows it is running on port 9000.",
      [],
      mockLLM,
    )
    assert.equal(res.verified, false, "regex fallback must catch falsified execution")
    assert.equal(res.type, "falsified_execution")
    assert.match(res.reason ?? "", /regex fallback/)
  } finally { cleanupRootDir(rootDir) }
})

test("checkTurnIntegrity: regex fallback passes when all flags are false", async () => {
  const rootDir = createRootDir()
  try {
    const mockLLM = async () => ({
      text: "hasBrokenPromise=false hasFalsifiedExecution=false hasUnverifiedIncapacity=false — todo en orden",
    })
    const res = await checkTurnIntegrity(
      rootDir,
      "No tool required, just an explanation.",
      [],
      mockLLM,
    )
    assert.equal(res.verified, true, "all-false regex fallback must pass")
  } finally { cleanupRootDir(rootDir) }
})

test("checkTurnIntegrity: survives LLM auditor returning markdown-fenced JSON", async () => {
  const rootDir = createRootDir()
  try {
    const mockLLM = async () => ({
      text: [
        "```json",
        "{",
        '  "hasBrokenPromise": false,',
        '  "hasFalsifiedExecution": true,',
        '  "hasUnverifiedIncapacity": false,',
        '  "reason": "Fenced JSON response"',
        "}",
        "```",
      ].join("\n"),
    })
    // Text must NOT trigger deterministic pre-check (no first-person past claim,
    // no structural tool output). Long enough to pass the trivial length gate.
    const res = await checkTurnIntegrity(
      rootDir,
      "Status of the local container: socket not present. Permission model denies the request.",
      [],
      mockLLM,
    )
    assert.equal(res.verified, false)
    assert.equal(res.type, "falsified_execution")
    assert.equal(res.reason, "Fenced JSON response")
  } finally { cleanupRootDir(rootDir) }
})
