import test from "node:test"
import assert from "node:assert/strict"
import { resolveOllamaResponseText } from "./ollamaText.ts"

test("resolveOllamaResponseText returns content as the reply", () => {
  const r = resolveOllamaResponseText("Hola!", "The user said hi. Let's respond: \"Ignored\"")
  assert.equal(r.text, "Hola!")
  assert.ok(r.thinking)
})

test("resolveOllamaResponseText never scrapes the chain-of-thought when content is empty", () => {
  const thinking = 'Should respond in Spanish. Let\'s respond: "Encantado, Cristian."'
  const r = resolveOllamaResponseText("", thinking)
  assert.equal(r.text, "")
  assert.equal(r.thinking, thinking)
})

test("resolveOllamaResponseText trims content and drops empty thinking", () => {
  const r = resolveOllamaResponseText("  Hola  ", "   ")
  assert.equal(r.text, "Hola")
  assert.equal(r.thinking, undefined)
})
