// Tests for the malformed tool-call detector. Regression for the
// 2026-06-09 23:21 incident where the model emitted
// "<ListMcpResourcesTool /> <old_string> [ListMcpResourcesTool] </parameter>"
// and the runtime delivered the garbage as a regular assistant
// message. The detector must flag it as malformed so the agent loop
// re-feeds the model with a "re-emit using structured format" prompt.

import test from "node:test"
import assert from "node:assert/strict"
import { looksLikeMalformedToolCall } from "./utils.ts"

test("looksLikeMalformedToolCall: returns false for empty input", () => {
  assert.equal(looksLikeMalformedToolCall(""), false)
})

test("looksLikeMalformedToolCall: returns false for natural text", () => {
  assert.equal(looksLikeMalformedToolCall("Hola, te mando el audio."), false)
  assert.equal(looksLikeMalformedToolCall("0 skills dinámicas."), false)
})

test("looksLikeMalformedToolCall: flags the 2026-06-09 garbage output", () => {
  const garbage = "<ListMcpResourcesTool /> <old_string> [ListMcpResourcesTool] </parameter>"
  assert.equal(looksLikeMalformedToolCall(garbage), true)
})

test("looksLikeMalformedToolCall: flags self-closing tool tag at start", () => {
  assert.equal(looksLikeMalformedToolCall("<Read />"), true)
  assert.equal(looksLikeMalformedToolCall("<Bash />"), true)
  assert.equal(looksLikeMalformedToolCall("<Edit />"), true)
})

test("looksLikeMalformedToolCall: flags bare PascalCase tool tag at start", () => {
  assert.equal(looksLikeMalformedToolCall("<Read>"), true)
  assert.equal(looksLikeMalformedToolCall("<TelegramSendPhoto>"), true)
})

test("looksLikeMalformedToolCall: flags self-closing tool tag mid-text", () => {
  assert.equal(looksLikeMalformedToolCall("garbage <Read /> more garbage"), true)
})

test("looksLikeMalformedToolCall: flags orphan closing tags", () => {
  assert.equal(looksLikeMalformedToolCall("</parameter>"), true)
  assert.equal(looksLikeMalformedToolCall("</invoke>"), true)
  assert.equal(looksLikeMalformedToolCall("</old_string>"), true)
  assert.equal(looksLikeMalformedToolCall("</new_string>"), true)
  assert.equal(looksLikeMalformedToolCall("</tool_call>"), true)
  assert.equal(looksLikeMalformedToolCall("</minimax:tool_call>"), true)
  assert.equal(looksLikeMalformedToolCall("</function_calls>"), true)
})

test("looksLikeMalformedToolCall: flags bracket-only tool name", () => {
  assert.equal(looksLikeMalformedToolCall("[Read]"), true)
  assert.equal(looksLikeMalformedToolCall("[Bash]"), true)
  assert.equal(looksLikeMalformedToolCall("  [Edit]  "), true)
})

test("looksLikeMalformedToolCall: does NOT flag XML in normal assistant prose", () => {
  // The detector should not false-positive on assistant prose that
  // happens to mention a tool name in brackets or angle brackets —
  // only on shapes that look like a real but malformed tool call.
  assert.equal(looksLikeMalformedToolCall("Probá con [Read] el archivo README."), false)
  assert.equal(looksLikeMalformedToolCall("Use el tool Read para abrir el archivo."), false)
})
