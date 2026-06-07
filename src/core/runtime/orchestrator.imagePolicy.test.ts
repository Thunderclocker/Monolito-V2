import test, { after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolated environment root before importing Monolito core modules
const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-image-policy-test-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

after(() => {
  rmSync(testMonolitoRoot, { recursive: true, force: true })
})

// Import via the registry barrel so the module init order matches
// production. Importing internal.ts directly trips a circular-init
// error in domains/file.ts (it reads `emptyInputSchema` from
// internal.ts before internal.ts has finished initializing).
const { indexRalphRulesInPalace } = await import("../tools/registry.ts")
const { listRalphRules, upsertRalphRule } = await import("../session/store.ts")
const internal = await import("../tools/internal.ts")

function createRootDir() {
  return mkdtempSync(join(tmpdir(), "monolito-image-policy-fresh-"))
}

function cleanupRootDir(rootDir: string) {
  rmSync(rootDir, { recursive: true, force: true })
}

test("imageVerificationSkipped short-circuits the buildTelegramPhotoWorkerTask verify branch", () => {
  const result = internal.buildTelegramPhotoWorkerTask(
    "task: get a photo",
    "telegram-1515784684",
    "verifica la última foto que te mandé, no analices solo mandá",
  )
  assert.ok(
    result.includes("NO uses VisionAnalyze"),
    `expected the skip branch, got: ${result.slice(0, 400)}`,
  )
})

test("requiresImageVerificationText no longer matches medical 'problemas de vision'", () => {
  assert.equal(internal.requiresImageVerificationText("tengo problemas de vision"), false)
  assert.equal(internal.requiresImageVerificationText("perdí vision en un ojo"), false)
})

test("image_verification Ralph rule is not re-indexed by indexRalphRulesInPalace", async () => {
  const rootDir = createRootDir()
  try {
    await indexRalphRulesInPalace(rootDir)
    const rules = listRalphRules(rootDir) as Array<{ key: string; content: string }>
    const names = rules.map((r) => r.key)
    assert.ok(
      !names.includes("image_verification"),
      `expected no image_verification rule, found: ${names.join(", ")}`,
    )
    assert.ok(
      names.includes("enumerate_dynamic_state"),
      `expected enumerate_dynamic_state rule, found: ${names.join(", ")}`,
    )
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("user-defined Ralph rule with requiredTools still fires (regression)", async () => {
  const rootDir = createRootDir()
  try {
    upsertRalphRule(rootDir, "custom_vision_check", JSON.stringify({
      name: "Custom Vision Check",
      description: "User-defined test rule that requires VisionAnalyze.",
      intentRegex: "\\b(mira|observá|chequeá visualmente)\\b",
      requiredRegex: "\\b(imagen|foto)\\b",
      requiredTools: ["VisionAnalyze"],
      errorMessage: "User rule: must run VisionAnalyze.",
    }))
    await indexRalphRulesInPalace(rootDir)
    const rules = listRalphRules(rootDir) as Array<{ key: string; content: string }>
    const custom = rules.find((r) => r.key === "custom_vision_check")
    assert.ok(custom, "custom user-defined rule should still be present after re-indexing")
    const parsed = JSON.parse(custom.content)
    assert.deepEqual(parsed.requiredTools, ["VisionAnalyze"])
  } finally {
    cleanupRootDir(rootDir)
  }
})
