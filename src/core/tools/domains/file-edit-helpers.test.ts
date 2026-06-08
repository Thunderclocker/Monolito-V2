// Tests para file-edit-helpers.ts

import test from "node:test"
import assert from "node:assert/strict"
import {
  applyEditToFile,
  containsCurlyQuotes,
  isNotebookFile,
  isMarkdownFile,
  isSettingsFile,
  isNoOpEdit,
  normalizeQuotes,
  countOccurrences,
  generateUnifiedDiff,
  areStringsEquivalent,
} from "./file-edit-helpers.ts"

test("applyEditToFile replaces single match", () => {
  const r = applyEditToFile("hello world", "world", "monolito")
  assert.equal(r.success, true)
  assert.equal(r.result, "hello monolito")
  assert.equal(r.matches, 1)
})

test("applyEditToFile replaces all when replaceAll=true", () => {
  const r = applyEditToFile("a b a b a", "a", "X", { replaceAll: true })
  assert.equal(r.success, true)
  assert.equal(r.result, "X b X b X")
  assert.equal(r.matches, 3)
})

test("applyEditToFile errors on multiple matches without replaceAll", () => {
  const r = applyEditToFile("a b a", "a", "X")
  assert.equal(r.success, false)
  assert.equal(r.matches, 2)
  assert.match(r.error!, /matched 2 times/)
})

test("applyEditToFile uses matchIndex to pick specific occurrence", () => {
  const r = applyEditToFile("a b a b a", "a", "X", { matchIndex: 2 })
  assert.equal(r.success, true)
  assert.equal(r.result, "a b a b X")
})

test("applyEditToFile errors on out-of-range matchIndex", () => {
  const r = applyEditToFile("a b a", "a", "X", { matchIndex: 5 })
  assert.equal(r.success, false)
  assert.match(r.error!, /out of range/)
})

test("applyEditToFile errors when old_string not found", () => {
  const r = applyEditToFile("hello", "world", "X")
  assert.equal(r.success, false)
  assert.equal(r.matches, 0)
  assert.match(r.error!, /not found/)
})

test("applyEditToFile with preserveQuoteStyle normalizes curly", () => {
  const r = applyEditToFile("hello ‘world’", "‘world’", "‘monolito’", { preserveQuoteStyle: true })
  // original has curly quotes; old_string has curly; preserveQuoteStyle
  // should normalize both sides
  assert.equal(r.success, true)
  assert.equal(r.result, "hello ‘monolito’")
})

test("isNotebookFile detects .ipynb", () => {
  assert.equal(isNotebookFile("foo.ipynb"), true)
  assert.equal(isNotebookFile("foo.IPYNB"), true)
  assert.equal(isNotebookFile("foo.txt"), false)
})

test("isMarkdownFile detects .md and .markdown", () => {
  assert.equal(isMarkdownFile("foo.md"), true)
  assert.equal(isMarkdownFile("foo.markdown"), true)
  assert.equal(isMarkdownFile("foo.MD"), true)
  assert.equal(isMarkdownFile("foo.txt"), false)
})

test("isSettingsFile detects settings.json patterns", () => {
  assert.equal(isSettingsFile("settings.json"), true)
  assert.equal(isSettingsFile("settings.local.json"), true)
  assert.equal(isSettingsFile("path/to/settings.json"), true)
  assert.equal(isSettingsFile("config.json"), false)
})

test("isNoOpEdit detects equivalent strings", () => {
  assert.equal(isNoOpEdit("a", "a"), true)
  assert.equal(isNoOpEdit("a", "b"), false)
  // curly vs straight
  assert.equal(isNoOpEdit("‘x’", "'x'"), true)
  assert.equal(isNoOpEdit("“x”", '"x"'), true)
})

test("normalizeQuotes converts curly to straight", () => {
  assert.equal(normalizeQuotes("‘hello’"), "'hello'")
  assert.equal(normalizeQuotes("“world”"), '"world"')
  assert.equal(normalizeQuotes("no quotes"), "no quotes")
})

test("containsCurlyQuotes detects curly", () => {
  assert.equal(containsCurlyQuotes("‘hi’"), true)
  assert.equal(containsCurlyQuotes("'hi'"), false)
})

test("countOccurrences counts all matches", () => {
  assert.equal(countOccurrences("aaa", "a"), 3)
  assert.equal(countOccurrences("hello", "world"), 0)
  assert.equal(countOccurrences("ababab", "ab"), 3)
})

test("generateUnifiedDiff produces diff format", () => {
  const diff = generateUnifiedDiff("line1\nline2\nline3", "line1\nmodified\nline3", "test.txt")
  assert.match(diff, /--- a\/test\.txt/)
  assert.match(diff, /\+\+\+ b\/test\.txt/)
  assert.match(diff, /-line2/)
  assert.match(diff, /\+modified/)
})

test("areStringsEquivalent ignores trailing whitespace", () => {
  assert.equal(areStringsEquivalent("hello", "hello  "), true)
  assert.equal(areStringsEquivalent("a\n", "a"), true)
  assert.equal(areStringsEquivalent("a", "b"), false)
})
