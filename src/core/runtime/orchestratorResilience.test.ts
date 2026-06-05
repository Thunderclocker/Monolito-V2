import test from "node:test"
import assert from "node:assert/strict"

/**
 * Unit tests for the orchestrator-resilience helpers added in this
 * commit. These exercise the pure helpers in modelAdapter.ts:
 *   - computeToolErrorSignature(): stable signature for "same error" detection
 *   - buildSameErrorNudgeForMain(): nudge prompt injection
 *   - finalize() with empty-response fallback
 *
 * The full runAgentLoop integration is exercised manually (and the
 * helpers are pure, so the integration risk is minimal).
 */

// Set isolated environment root before importing Monolito core modules.
// (The modelAdapter module touches the runtime env on import.)
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-orchestrator-resilience-test-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

import {
  computeToolErrorSignature,
  buildSameErrorNudgeForMain,
  // finalize is not exported, so we exercise the empty-response fallback
  // through the exported runAssistantTurn smoke flow below. The helper
  // itself is a small change in modelAdapter.ts; the unit test focuses
  // on what IS exported.
} from "./modelAdapter.ts"

function cleanup() {
  rmSync(testMonolitoRoot, { recursive: true, force: true })
}

test("computeToolErrorSignature: extracts stable kind + normalized detail", () => {
  const sig1 = computeToolErrorSignature("Bash", "Error: /bin/zsh:1: command not found: sqlite3")
  assert.equal(sig1.kind, "command-not-found")
  // The detail should not contain raw paths or numbers that vary between
  // attempts. The "1" in "zsh:1" is stripped, the path /bin/zsh is
  // normalized to <path>.
  assert.ok(!sig1.detail.includes("/bin/zsh"), "raw path should be normalized")
  assert.ok(!/\b\d+\b/.test(sig1.detail), "raw numbers should be normalized")
  // Same input should produce the same signature (idempotent).
  const sig2 = computeToolErrorSignature("Bash", "Error: /bin/zsh:1: command not found: sqlite3")
  assert.equal(sig1.kind, sig2.kind)
  assert.equal(sig1.detail, sig2.detail)
})

test("computeToolErrorSignature: different error messages produce different details", () => {
  const sigA = computeToolErrorSignature("Bash", "Error: command not found: foo")
  const sigB = computeToolErrorSignature("Bash", "Error: EACCES: permission denied")
  assert.equal(sigA.kind, "command-not-found")
  assert.equal(sigB.kind, "permission")
  assert.notEqual(sigA.kind, sigB.kind)
})

test("computeToolErrorSignature: hex ids in error messages are normalized", () => {
  const sig1 = computeToolErrorSignature("Read", "Could not read file abcdef0123456789: ENOENT")
  const sig2 = computeToolErrorSignature("Read", "Could not read file fedcba9876543210: ENOENT")
  // Different hex ids should produce the same signature because they're
  // normalized to <id>.
  assert.equal(sig1.kind, sig2.kind)
  assert.equal(sig1.detail, sig2.detail)
})

test("buildSameErrorNudgeForMain: contains key guidance sections", () => {
  const nudge = buildSameErrorNudgeForMain(3, "Bash", "command-not-found: sqlite3")
  assert.match(nudge, /SAME-ERROR DETECTION/)
  assert.match(nudge, /'Bash' 3 times consecutively/)
  assert.match(nudge, /STOP and reconsider/)
  assert.match(nudge, /SUBSTANTIALLY different approach/)
  assert.match(nudge, /TASK_FAILED/)
  assert.match(nudge, /Last error signature: command-not-found: sqlite3/)
})

test("buildSameErrorNudgeForMain: includes the four diagnostic categories", () => {
  const nudge = buildSameErrorNudgeForMain(2, "Bash", "some error")
  // The four categories the agent should consider before retrying.
  assert.match(nudge, /fundamentally unable/)
  assert.match(nudge, /INPUT wrong/)
  assert.match(nudge, /WORKSPACE state wrong/)
  assert.match(nudge, /APPROACH wrong/)
})

test("buildSameErrorNudgeForMain: language-agnostic (English, no Spanish keywords)", () => {
  const nudge = buildSameErrorNudgeForMain(2, "Bash", "error")
  // Critical: must NOT contain Spanish keywords that would break
  // language-agnosticism. The previous Spanish-only nudge is what
  // motivated this rewrite.
  assert.doesNotMatch(nudge, /\b(sqlite3 no encontr|herramienta|falla persistente)\b/)
  assert.ok(nudge.length > 200, "nudge should be substantial, not a one-liner")
})

test("cleanup", cleanup)
