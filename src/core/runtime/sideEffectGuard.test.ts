import test, { after } from "node:test"
import assert from "node:assert/strict"
import { checkSideEffects, setSideEffectGuardLogger } from "./sideEffectGuard.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Set isolated environment root before importing Monolito core modules
const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-side-effect-guard-test-root-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

after(() => {
  rmSync(testMonolitoRoot, { recursive: true, force: true })
  setSideEffectGuardLogger(null)
})

function createRootDir() {
  return mkdtempSync(join(tmpdir(), "monolito-side-effect-guard-test-"))
}

function cleanupRootDir(rootDir: string) {
  rmSync(rootDir, { recursive: true, force: true })
}

test("checkSideEffects - imperative pipe-table with VoiceClone purge bypasses the LLM judge (Fix 4)", async () => {
  const rootDir = createRootDir()
  try {
    let judgeCalled = false
    const mockJudge = async () => {
      judgeCalled = true
      return { text: JSON.stringify({ approved: false, reason: "should not be reached" }) }
    }

    const result = await checkSideEffects(
      rootDir,
      [{ name: "VoiceClone", input: { action: "purge", alias: "amanda_voz" } }],
      [],
      "default",
      "elimina | amanda_voz | 2026-06-09 | | cristian | 2026-06-09 | | cristian_v2 | 2026-06-09 |",
      mockJudge,
    )

    assert.equal(result.approved, true, "imperative pipe-table with destructive verb must approve")
    assert.equal(judgeCalled, false, "LLM judge must NOT be invoked when the imperative pre-check matches")
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("checkSideEffects - imperative 'delete this voice' (English) bypasses the judge for VoiceClone", async () => {
  const rootDir = createRootDir()
  try {
    let judgeCalled = false
    const mockJudge = async () => {
      judgeCalled = true
      return { text: JSON.stringify({ approved: false, reason: "should not be reached" }) }
    }

    const result = await checkSideEffects(
      rootDir,
      [{ name: "VoiceClone", input: { action: "purge", voice_id: "amanda_voz" } }],
      [],
      "default",
      "delete this voice please",
      mockJudge,
    )

    assert.equal(result.approved, true, "English imperative must also trigger the pre-check")
    assert.equal(judgeCalled, false)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("checkSideEffects - 'lista las voces' (non-imperative) does NOT bypass — judge is called", async () => {
  const rootDir = createRootDir()
  try {
    let judgeCalled = false
    const mockJudge = async () => {
      judgeCalled = true
      return { text: JSON.stringify({ approved: true, reason: "" }) }
    }

    const result = await checkSideEffects(
      rootDir,
      [{ name: "VoiceClone", input: { action: "list" } }],
      [],
      "default",
      "lista las voces clonadas",
      mockJudge,
    )

    assert.equal(judgeCalled, true, "Non-imperative messages must still go through the judge")
    assert.equal(result.approved, true)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("checkSideEffects - 'elimina todo' with TelegramSend (non-whitelisted) does NOT bypass", async () => {
  const rootDir = createRootDir()
  try {
    let judgeCalled = false
    const mockJudge = async () => {
      judgeCalled = true
      return { text: JSON.stringify({ approved: true, reason: "" }) }
    }

    const result = await checkSideEffects(
      rootDir,
      [{ name: "TelegramSend", input: { text: "hola" } }],
      [],
      "default",
      "elimina todo lo que enviaste",
      mockJudge,
    )

    assert.equal(judgeCalled, true, "TelegramSend is NOT in the destructive whitelist, so the judge must run")
    assert.equal(result.approved, true)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("checkSideEffects - empty pendingTools is approved without invoking the judge", async () => {
  const rootDir = createRootDir()
  try {
    let judgeCalled = false
    const mockJudge = async () => {
      judgeCalled = true
      return { text: JSON.stringify({ approved: false }) }
    }

    const result = await checkSideEffects(
      rootDir,
      [],
      [],
      "default",
      "elimina todo",
      mockJudge,
    )

    assert.equal(result.approved, true)
    assert.equal(judgeCalled, false)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("checkSideEffects - mixed pendingTools (VoiceClone + TelegramSend) does NOT bypass", async () => {
  const rootDir = createRootDir()
  try {
    let judgeCalled = false
    const mockJudge = async () => {
      judgeCalled = true
      return { text: JSON.stringify({ approved: true, reason: "" }) }
    }

    const result = await checkSideEffects(
      rootDir,
      [
        { name: "VoiceClone", input: { action: "purge", alias: "amanda_voz" } },
        { name: "TelegramSend", input: { text: "done" } },
      ],
      [],
      "default",
      "elimina amanda_voz",
      mockJudge,
    )

    assert.equal(judgeCalled, true, "Mixed pending tools must go through the judge (whitelist requires ALL to be destructive)")
    assert.equal(result.approved, true)
  } finally {
    cleanupRootDir(rootDir)
  }
})
