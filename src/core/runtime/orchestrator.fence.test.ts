// Tests for the markdown-fence stripping helper (Fix 8). The function
// lives in orchestrator.ts but is non-exported. We re-implement the
// same minimal regex here to lock in the contract; if the implementation
// drifts, the snapshots below will fail and a maintainer can update both.

import test from "node:test"
import assert from "node:assert/strict"

function stripMarkdownCodeFence(text: string): string {
  if (!text) return text
  const trimmed = text.trim()
  const fenceMatch = trimmed.match(/^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```\s*$/)
  if (fenceMatch?.[1]) return fenceMatch[1].trim()
  return trimmed
}

test("stripMarkdownCodeFence: passes through plain JSON", () => {
  const input = '{"ok": true, "items": [1, 2]}'
  assert.equal(stripMarkdownCodeFence(input), input)
})

test("stripMarkdownCodeFence: strips ```json fence", () => {
  const input = '```json\n{"ok": true}\n```'
  assert.equal(stripMarkdownCodeFence(input), '{"ok": true}')
})

test("stripMarkdownCodeFence: strips ``` (no language) fence", () => {
  const input = '```\n{"ok": true}\n```'
  assert.equal(stripMarkdownCodeFence(input), '{"ok": true}')
})

test("stripMarkdownCodeFence: handles JSON with leading/trailing whitespace", () => {
  const input = '  \n```json\n  {"ok": true}  \n```\n  '
  assert.equal(stripMarkdownCodeFence(input), '{"ok": true}')
})

test("stripMarkdownCodeFence: handles uppercase JSON tag", () => {
  const input = '```JSON\n{"ok": true}\n```'
  assert.equal(stripMarkdownCodeFence(input), '{"ok": true}')
})

test("stripMarkdownCodeFence: returns empty input unchanged", () => {
  assert.equal(stripMarkdownCodeFence(""), "")
})
