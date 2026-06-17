import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "monolito-websearch-config-"))
process.env.MONOLITO_ROOT = root

const { readWebSearchConfig, writeWebSearchConfig } = await import("./config.ts")

test.after(() => {
  rmSync(root, { recursive: true, force: true })
})

test("readWebSearchConfig infers brave when apiKey is set but provider is default", () => {
  writeWebSearchConfig({ provider: "default", apiKey: "test-brave-key" })
  const config = readWebSearchConfig()
  assert.equal(config.provider, "brave")
  assert.equal(config.apiKey, "test-brave-key")
})

test("readWebSearchConfig keeps explicit serper provider", () => {
  writeWebSearchConfig({ provider: "serper", apiKey: "serper-key" })
  const config = readWebSearchConfig()
  assert.equal(config.provider, "serper")
  assert.equal(config.apiKey, "serper-key")
})

test("tryAutoConfigureWebSearchFromUserMessage saves lone pasted API key", async () => {
  const { tryAutoConfigureWebSearchFromUserMessage } = await import("./config.ts")
  writeWebSearchConfig({ provider: "default" })
  const result = tryAutoConfigureWebSearchFromUserMessage("BSAYcJPXJ9LetUlprVYPBRjXuwsuwUR")
  assert.equal(result.configured, true)
  assert.equal(result.redactedText, "[REDACTED]")
  assert.equal(readWebSearchConfig().provider, "brave")
  assert.equal(readWebSearchConfig().apiKey, "BSAYcJPXJ9LetUlprVYPBRjXuwsuwUR")
})
