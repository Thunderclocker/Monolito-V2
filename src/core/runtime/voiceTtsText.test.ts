import test from "node:test"
import assert from "node:assert/strict"
import { prepareTextForTts } from "./voiceTtsText.ts"

test("prepareTextForTts: strips markdown and truncates word count", () => {
  const input = "## Título\n\n**Hola** con `código` y [link](https://example.com).\n- item uno\n- item dos"
  const out = prepareTextForTts(input, 10)
  assert.ok(!out.includes("##"))
  assert.ok(!out.includes("**"))
  assert.ok(!out.includes("`"))
  assert.ok(out.includes("Hola"))
  assert.ok(out.endsWith("…") || out.split(/\s+/).length <= 10)
})
