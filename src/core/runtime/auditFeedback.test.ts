// Tests for the audit feedback wrapper. The wrapper is the contract that
// every piece of runtime-injected feedback (Ralph Gate, side-effect guard,
// tdd-react, etc.) must respect so the model can distinguish audit traffic
// from user-facing messages.

import test from "node:test"
import assert from "node:assert/strict"
import {
  wrapAuditFeedback,
  AUDIT_FEEDBACK_OPEN,
  AUDIT_FEEDBACK_CLOSE,
  AUDIT_FEEDBACK_TAIL,
} from "./auditFeedback.ts"

test("wrapAuditFeedback: opens and closes with the canonical markers", () => {
  const out = wrapAuditFeedback("hello world")
  assert.ok(out.startsWith(AUDIT_FEEDBACK_OPEN))
  assert.ok(out.includes("hello world"))
  assert.ok(out.includes(AUDIT_FEEDBACK_CLOSE))
  assert.ok(out.endsWith(AUDIT_FEEDBACK_TAIL))
})

test("wrapAuditFeedback: trims outer whitespace from the body", () => {
  const out = wrapAuditFeedback("   \n\n  hello  \n\n  ")
  // The body inside the markers is the trimmed version, not the padded one.
  const openIdx = out.indexOf(AUDIT_FEEDBACK_OPEN)
  const closeIdx = out.indexOf(AUDIT_FEEDBACK_CLOSE)
  const between = out.slice(openIdx + AUDIT_FEEDBACK_OPEN.length, closeIdx)
  assert.match(between, /\n\nhello\n\n/)
  assert.ok(!between.includes("  hello  "))
})

test("wrapAuditFeedback: tail reminds the model to respond naturally", () => {
  const out = wrapAuditFeedback("anything")
  assert.match(out, /no un reporte sobre este feedback/i)
  assert.match(out, /tu próxima respuesta al usuario debe ser natural/i)
})

test("wrapAuditFeedback: is generic (no user-specific name)", () => {
  const out = wrapAuditFeedback("anything")
  // The wrapper must not hardcode a user name; it must use "el usuario" /
  // generic phrasing so the same feedback works in any profile.
  assert.ok(!/\bCristian\b/.test(out))
  assert.ok(/\busuario\b/.test(out))
})

test("wrapAuditFeedback: empty body still produces a valid envelope", () => {
  const out = wrapAuditFeedback("")
  assert.ok(out.includes(AUDIT_FEEDBACK_OPEN))
  assert.ok(out.includes(AUDIT_FEEDBACK_CLOSE))
  assert.ok(out.endsWith(AUDIT_FEEDBACK_TAIL))
})
