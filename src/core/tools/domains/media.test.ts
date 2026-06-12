import { after, test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-media-test-"))
process.env.MONOLITO_ROOT = testMonolitoRoot
process.env.MONOLITO_TEST_GUARD = "0"

const { getTool } = await import("../registry.ts")

after(() => {
  rmSync(testMonolitoRoot, { recursive: true, force: true })
})

test("VoiceClone tool validation rules", () => {
  const tool = getTool("VoiceClone")
  assert.ok(tool)

  // Invalid action
  assert.match(tool.validate!({ action: "invalid_action" })!, /action must be/)

  // Clone validation: missing alias
  assert.match(tool.validate!({ action: "clone" })!, /alias is required/)

  // Clone validation: invalid alias
  assert.match(tool.validate!({ action: "clone", alias: "Voz!Inválida" })!, /alias debe ser alfanumerico/)

  // Clone validation: missing source
  assert.match(tool.validate!({ action: "clone", alias: "valida" })!, /source.type must be/)

  // Rename validation: missing old alias
  assert.match(tool.validate!({ action: "rename" })!, /alias \(old\) is required/)

  // Rename validation: missing new alias
  assert.match(tool.validate!({ action: "rename", alias: "old" })!, /new_alias is required/)

  // Rename validation: missing source
  assert.match(tool.validate!({ action: "rename", alias: "old", new_alias: "new" })!, /source \(new audio\) is required/)
})

test("VoiceClone purge handles alias fallback when not in config", async () => {
  const tool = getTool("VoiceClone")
  assert.ok(tool)

  const { writeChannelsConfig } = await import("../../channels/config.ts")
  writeChannelsConfig({
    tts: {
      provider: "minimax",
      apiKey: "fake-api-key",
      clonedVoices: {},
    },
  })

  const result = await tool.run({
    action: "purge",
    alias: "voz_inexistente_local",
  }, {
    rootDir: testMonolitoRoot,
    cwd: testMonolitoRoot,
  }) as { ok: boolean; voice_id: string; remote_error?: string }

  assert.equal(result.voice_id, "voz_inexistente_local")
})
