import test from "node:test"
import assert from "node:assert/strict"
import { resolveOllamaThink } from "./ollama.ts"

test("reasoning models never get think:false (floor at low)", () => {
  assert.equal(resolveOllamaThink("gpt-oss:20b", { enabled: false }), "low")
  assert.equal(resolveOllamaThink("gpt-oss:20b", { enabled: false, level: "off" }), "low")
  assert.equal(resolveOllamaThink("deepseek-r1:7b", undefined), "low")
})

test("reasoning models honor the configured granular level when enabled", () => {
  assert.equal(resolveOllamaThink("gpt-oss:20b", { enabled: true, level: "high" }), "high")
  assert.equal(resolveOllamaThink("gpt-oss:20b", { enabled: true, level: "medium" }), "medium")
})

test("non-reasoning models disable thinking when off", () => {
  assert.equal(resolveOllamaThink("llama3.1:8b", { enabled: false }), false)
  assert.equal(resolveOllamaThink("qwen2.5:7b", undefined), false)
})

test("non-reasoning models still honor an explicitly enabled level", () => {
  assert.equal(resolveOllamaThink("llama3.1:8b", { enabled: true, level: "low" }), "low")
})
