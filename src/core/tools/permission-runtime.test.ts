// Tests para permission-runtime.ts

import test from "node:test"
import assert from "node:assert/strict"
import { matchWildcard } from "./permission-runtime.ts"

test("matchWildcard exact match", () => {
  assert.equal(matchWildcard("Bash", "Bash"), true)
  assert.equal(matchWildcard("Bash", "Edit"), false)
})

test("matchWildcard with * glob", () => {
  assert.equal(matchWildcard("Bash*", "Bash"), true)
  assert.equal(matchWildcard("Bash*", "BashRun"), true)
  assert.equal(matchWildcard("Bash*", "Edit"), false)
  assert.equal(matchWildcard("*Tool", "MyTool"), true)
  assert.equal(matchWildcard("*Tool", "Tool"), true)
  assert.equal(matchWildcard("*Tool", "Tools"), false)
})

test("matchWildcard with ? single-char", () => {
  assert.equal(matchWildcard("B?s?", "Bash"), true)
  assert.equal(matchWildcard("B?s?", "Bus"), false)
  assert.equal(matchWildcard("Fi?e", "File"), true)
})

test("matchWildcard combined * and ?", () => {
  assert.equal(matchWildcard("Mcp*Resource*", "McpListResourcesTool"), true)
  assert.equal(matchWildcard("Mcp*Resource*", "McpReadResourceTool"), true)
  assert.equal(matchWildcard("Mcp*Resource*", "Bash"), false)
})

test("matchWildcard escapes regex metachars", () => {
  assert.equal(matchWildcard("a.b", "a.b"), true)
  assert.equal(matchWildcard("a.b", "axb"), false)
})
