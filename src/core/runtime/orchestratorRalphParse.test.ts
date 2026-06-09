// Tests for Ralph Loop JSON parse helper.
//
// Bug #6 (09-jun-2026): 7 SyntaxError occurrences in monolitod.*.log when
// the semantic verification LLM returned markdown-wrapped or truncated
// JSON. The old code only did one JSON.parse attempt and silently fell
// back to regex heuristics, losing classifier precision and giving no
// diagnostic trail.

import { test } from "node:test"
import assert from "node:assert/strict"
import { parseRalphLoopClassification } from "./orchestrator.ts"

test("parseRalphLoopClassification: clean JSON object", () => {
  const input = '{"send_telegram_photo": true, "send_telegram_file": false}'
  const parsed = parseRalphLoopClassification(input) as Record<string, unknown>
  assert.equal(parsed.send_telegram_photo, true)
  assert.equal(parsed.send_telegram_file, false)
})

test("parseRalphLoopClassification: JSON in ```json fence", () => {
  const input = '```json\n{"send_telegram_photo": true}\n```'
  const parsed = parseRalphLoopClassification(input) as Record<string, unknown>
  assert.equal(parsed.send_telegram_photo, true)
})

test("parseRalphLoopClassification: JSON in ``` fence without language tag", () => {
  const input = '```\n{"search_web": true}\n```'
  const parsed = parseRalphLoopClassification(input) as Record<string, unknown>
  assert.equal(parsed.search_web, true)
})

test("parseRalphLoopClassification: JSON with leading prose", () => {
  // The LLM sometimes prefixes with 'Here is the classification: ' or similar.
  // The first attempt fails on the leading prose; the second extracts {...}.
  const input = 'Here you go:\n\n{"modify_workspace_files": true, "search_web": false}'
  const parsed = parseRalphLoopClassification(input) as Record<string, unknown>
  assert.equal(parsed.modify_workspace_files, true)
  assert.equal(parsed.search_web, false)
})

test("parseRalphLoopClassification: JSON with trailing garbage", () => {
  const input = '{"send_telegram_msg": true}\n\nLet me know if you need more.'
  const parsed = parseRalphLoopClassification(input) as Record<string, unknown>
  assert.equal(parsed.send_telegram_msg, true)
})

test("parseRalphLoopClassification: truncated fragment returns null (bug #6 case)", () => {
  // This is the exact 'Unexpected end of JSON input' shape observed in logs.
  const input = '{"send_telegram_photo": true, "send_telegram_file":'
  assert.equal(parseRalphLoopClassification(input), null)
})

test("parseRalphLoopClassification: garbage returns null", () => {
  assert.equal(parseRalphLoopClassification("I cannot classify this"), null)
})

test("parseRalphLoopClassification: empty string returns null", () => {
  assert.equal(parseRalphLoopClassification(""), null)
})

test("parseRalphLoopClassification: nested object within prose", () => {
  // LLM might wrap in markdown inline (the '`Unexpected token '`'` case)
  const input = '`{"send_telegram_photo": true}`'
  const parsed = parseRalphLoopClassification(input) as Record<string, unknown>
  assert.equal(parsed.send_telegram_photo, true)
})

test("parseRalphLoopClassification: only first JSON object is extracted", () => {
  // If the LLM returns two objects (rare), we take the first.
  const input = '{"a": 1}{"b": 2}'
  const parsed = parseRalphLoopClassification(input) as Record<string, unknown>
  assert.equal(parsed.a, 1)
  assert.equal(parsed.b, undefined)
})
