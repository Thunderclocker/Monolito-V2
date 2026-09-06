import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const testRoot = mkdtempSync(join(tmpdir(), "monolito-bootstrap-"))
process.env.MONOLITO_ROOT = testRoot

// Clean any pre-existing env vars that could affect bootstrap
const envBackup = { ...process.env }
before(() => {
  for (const k of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "API_TIMEOUT_MS",
    "MAX_BUDGET_USD",
  ]) {
    delete process.env[k]
  }
})
after(() => {
  rmSync(testRoot, { recursive: true, force: true })
  process.env = envBackup
})

test("bootstrapConfigFromEnv is a no-op when env has no auth token", async () => {
  const { bootstrapConfigFromEnv } = await import("./modelConfig.ts")
  const { readModelSettings } = await import("./modelConfig.ts")
  const before = readModelSettings().env.ANTHROPIC_AUTH_TOKEN
  await bootstrapConfigFromEnv({} as NodeJS.ProcessEnv)
  const after = readModelSettings().env.ANTHROPIC_AUTH_TOKEN
  assert.equal(after, before, "Auth token should not change with empty env")
})

test("bootstrapConfigFromEnv copies env into CONF_SYSTEM on first run", async () => {
  const { bootstrapConfigFromEnv, readModelSettings } = await import("./modelConfig.ts")
  const fakeEnv = {
    ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
    ANTHROPIC_AUTH_TOKEN: "test-token-12345",
    ANTHROPIC_MODEL: "test-model",
    API_TIMEOUT_MS: "60000",
    MAX_BUDGET_USD: "10",
  } as unknown as NodeJS.ProcessEnv
  await bootstrapConfigFromEnv(fakeEnv)
  const settings = readModelSettings()
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.minimax.io/anthropic")
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "test-token-12345")
  assert.equal(settings.env.ANTHROPIC_MODEL, "test-model")
})

test("bootstrapConfigFromEnv does not clobber configured settings when a profile already exists", async () => {
  const { bootstrapConfigFromEnv, readModelSettings, saveModelSettings } = await import("./modelConfig.ts")
  saveModelSettings({
    modelConfig: { protocol: "anthropic_compatible" },
    env: {
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_AUTH_TOKEN: "user-set-token",
      ANTHROPIC_MODEL: "user-set-model",
      API_TIMEOUT_MS: "3000000",
      MAX_BUDGET_USD: "0",
    },
  })

  await bootstrapConfigFromEnv({
    ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
    ANTHROPIC_AUTH_TOKEN: "env-token-should-lose",
    ANTHROPIC_MODEL: "env-model",
  } as unknown as NodeJS.ProcessEnv)

  const settings = readModelSettings()
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com")
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "user-set-token")
  assert.equal(settings.env.ANTHROPIC_MODEL, "user-set-model")
})
