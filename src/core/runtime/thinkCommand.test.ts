import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isReasoningModel } from "./modelRegistry.ts"
import { MonolitoV2Runtime } from "./runtime.ts"
import { getActiveProfile, addProfile } from "./modelRegistry.ts"

const testRoot = mkdtempSync(join(tmpdir(), "monolito-think-test-"))

before(() => {
  process.env.MONOLITO_ROOT = testRoot
  // Add a fake active profile
  addProfile({
    name: "test-profile",
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    model: "gpt-oss:20b",
    reasoningLevel: "off"
  })
})

after(() => {
  rmSync(testRoot, { recursive: true, force: true })
})

test("isReasoningModel correctly identifies reasoning models", () => {
  assert.equal(isReasoningModel("ollama", "gpt-oss:20b"), true)
  assert.equal(isReasoningModel("ollama", "deepseek-r1"), true)
  assert.equal(isReasoningModel("ollama", "qwen-coder"), false)
  assert.equal(isReasoningModel("anthropic_compatible", "claude-3-5-sonnet"), false)
})

test("/think command updates profile and handles warnings", async () => {
  const runtime = new MonolitoV2Runtime(testRoot)

  // No args -> show current level
  const reply1 = await runtime.runDaemonCommand("/think")
  assert.match(reply1, /Nivel de razonamiento actual: off/)

  // Invalid level -> error
  const reply2 = await runtime.runDaemonCommand("/think invalid")
  assert.match(reply2, /Uso: \/think/)

  // Set to high
  const reply3 = await runtime.runDaemonCommand("/think high")
  assert.match(reply3, /Nivel de razonamiento establecido a: high/)
  assert.equal(getActiveProfile()?.reasoningLevel, "high")

  // Set to off on a reasoning model (gpt-oss is in active profile)
  const reply4 = await runtime.runDaemonCommand("/think off")
  assert.match(reply4, /Advertencia: El modelo 'gpt-oss:20b' requiere razonamiento/)
  assert.equal(getActiveProfile()?.reasoningLevel, "off")
})
