import test from "node:test"
import assert from "node:assert/strict"
import { extractUserFacingTextFromThinking, resolveOllamaResponseText } from "./ollamaText.ts"

test("resolveOllamaResponseText prefers content over thinking", () => {
  const r = resolveOllamaResponseText("Hola!", "The user said hi. Let's respond: \"Ignored\"")
  assert.equal(r.text, "Hola!")
})

test("extractUserFacingTextFromThinking pulls quoted reply from gpt-oss style thinking", () => {
  const thinking = [
    'The user says in Spanish: "me llamo cristian". They expect a greeting.',
    'Let\'s respond: "¡Hola Cristian! ¿En qué puedo ayudarte hoy?"',
  ].join("\n")
  assert.equal(
    extractUserFacingTextFromThinking(thinking),
    "¡Hola Cristian! ¿En qué puedo ayudarte hoy?",
  )
})

test("resolveOllamaResponseText uses thinking fallback when content is empty", () => {
  const thinking = 'Should respond in Spanish. Let\'s respond: "Encantado, Cristian."'
  const r = resolveOllamaResponseText("", thinking)
  assert.equal(r.text, "Encantado, Cristian.")
  assert.equal(r.thinking, thinking)
})

test("resolveOllamaResponseText returns empty when nothing extractable", () => {
  const r = resolveOllamaResponseText("", "The user said hello. I should greet them.")
  assert.equal(r.text, "")
  assert.ok(r.thinking)
})
