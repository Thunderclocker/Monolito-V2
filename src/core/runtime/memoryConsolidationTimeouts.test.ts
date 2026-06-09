// Tests for the MemoryAgent timeout configuration.
//
// Bug #2 (09-jun-2026): 36 'Turn duration exceeded' / 'empty final text'
// consolidation failures even after commit 63fbb8c bumped the inner cap
// to 120s. Root cause: the outer wall-clock (90s) was tighter than the
// inner cap (120s), so the outer killed the turn before the inner could
// produce output. Fix: outer 200s, inner 180s.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const runtimePath = join(import.meta.dirname, "runtime.ts")
const src = readFileSync(runtimePath, "utf8")

test("MemoryAgent: outer wall-clock timeout is >= 200_000ms (was 90_000)", () => {
  // Look for the legacy runMemoryConsolidation outer timeout. The 90_000
  // that was there before the fix should no longer be paired with the
  // MemoryAgent outer abort (the SkillsAgent CREATE at line ~1805 keeps
  // 90_000 for unrelated reasons).
  const start = src.indexOf("async runMemoryConsolidation(")
  const end = src.indexOf("private async runMemoryConsolidationIncremental")
  const memoryAgentBlock = start >= 0 && end > start ? src.slice(start, end) : ""
  assert.ok(memoryAgentBlock.includes("200_000"), "outer timeout must be at least 200s")
  assert.ok(!memoryAgentBlock.includes("90_000"), "outer 90_000 timeout must be replaced")
})

test("MemoryAgent: inner maxTurnDurationMs is >= 180_000ms (was 120_000)", () => {
  const start = src.indexOf("async runMemoryConsolidation(")
  const end = src.indexOf("private async runMemoryConsolidationIncremental")
  const memoryAgentBlock = start >= 0 && end > start ? src.slice(start, end) : ""
  assert.ok(/maxTurnDurationMs:\s*18\d_000/.test(memoryAgentBlock), "inner cap must be at least 180s")
  assert.ok(!memoryAgentBlock.includes("maxTurnDurationMs: 120_000"), "inner 120_000 cap must be replaced")
})

test("MemoryAgent: incremental path also uses 200_000ms (was 90_000)", () => {
  // The incremental path lives in the second runMemoryConsolidation* helper.
  // Match the simpler 200_000 pattern that must appear.
  const matches = src.match(/200_000/g) ?? []
  assert.ok(matches.length >= 2, `expected at least 2 occurrences of 200_000, got ${matches.length}`)
})

test("MemoryAgent: timing breakdown emitted to worklog on success and failure", () => {
  // Both success and error branches should call appendWorklog with a
  // timing summary that includes 'total=...ms'.
  const successBranch = src.match(/if \(success\)/)?.[0]
  assert.ok(successBranch, "success branch must exist")
  const errorWorklog = src.match(/Consolidation timing:[^"\\]+/g) ?? []
  assert.ok(errorWorklog.length >= 1, "must emit timing summary in worklog on success")
  // The catch path also has a 'total=' timing line.
  const catchBranch = src.match(/catch \(e\)/)
  assert.ok(catchBranch, "catch branch must exist")
  const totalMatches = src.match(/total=\$\{totalMs\}ms/g) ?? []
  assert.ok(totalMatches.length >= 2, "must emit total timing in both success and catch paths")
})
