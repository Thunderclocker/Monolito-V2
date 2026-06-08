// Tests para semantic-classifier.ts

import test from "node:test"
import assert from "node:assert/strict"
import {
  semanticMatch,
  parseResponse,
  isSemanticClassifierEnabled,
  clearSemanticCache,
  hashKey,
} from "./semantic-classifier.ts"

// Test the parseResponse directly
test("parseResponse: yes", () => {
  assert.equal(parseResponse("yes"), "yes")
  assert.equal(parseResponse("YES"), "yes")
  assert.equal(parseResponse("y"), "yes")
  assert.equal(parseResponse("yes, definitely"), "yes")
  assert.equal(parseResponse("Yes."), "yes")
})

test("parseResponse: no", () => {
  assert.equal(parseResponse("no"), "no")
  assert.equal(parseResponse("NO"), "no")
  assert.equal(parseResponse("n"), "no")
  assert.equal(parseResponse("no, that's fine"), "no")
})

test("parseResponse: unsure", () => {
  assert.equal(parseResponse("maybe"), "unsure")
  assert.equal(parseResponse("I don't know"), "unsure")
  assert.equal(parseResponse(""), "unsure")
})

test("hashKey: stable", () => {
  const a = hashKey("test")
  const b = hashKey("test")
  assert.equal(a, b)
})

test("hashKey: different for different inputs", () => {
  assert.notEqual(hashKey("a"), hashKey("b"))
})

test("semanticMatch: default stub returns unsure", async () => {
  clearSemanticCache()
  const result = await semanticMatch(
    { id: "test-rule", description: "test description" },
    "ls -la",
  )
  // Default stub returns "unsure", which is deny-by-default
  assert.equal(result, "unsure")
})

test("semanticMatch: caches result", async () => {
  clearSemanticCache()
  let calls = 0
  const mockClassifier = async (_prompt: string) => {
    calls++
    return "no"
  }
  const rule = { id: "cache-test", description: "test" }
  const cmd = "echo hello"
  const r1 = await semanticMatch(rule, cmd, mockClassifier)
  const r2 = await semanticMatch(rule, cmd, mockClassifier)
  assert.equal(r1, "no")
  assert.equal(r2, "no")
  assert.equal(calls, 1, "second call should hit cache")
})

test("isSemanticClassifierEnabled: off by default", () => {
  delete process.env.MONOLITO_BASH_SEMANTIC_PERMISSIONS
  assert.equal(isSemanticClassifierEnabled(), false)
})

test("isSemanticClassifierEnabled: on with env var", () => {
  process.env.MONOLITO_BASH_SEMANTIC_PERMISSIONS = "1"
  assert.equal(isSemanticClassifierEnabled(), true)
  delete process.env.MONOLITO_BASH_SEMANTIC_PERMISSIONS
})
