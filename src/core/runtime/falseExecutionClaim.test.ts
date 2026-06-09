// Tests for the false-execution-claim classifier used by the coherence
// guard bypass/abort decision.
//
// Bug #3 (09-jun-2026): 6 'Coherence guard bypassed' occurrences on
// 2026-06-08 between 19:26 and 19:52. The model reported "Mandada.
// 864×1152, 125KB" without ever invoking GenerateImage or
// TelegramSendPhoto. The guard detected the incoherence but BYPASSED
// after 2 corrections, letting the inflated message reach the user.
//
// The fix: classify the rejection reason. If it's a 'false execution
// claim' (model claims it ran X but worklog shows it didn't), abort on
// the FIRST hit. For other incoherence (delegation, memory conflict),
// keep the 2-strikes-then-bypass policy.

import { test } from "node:test"
import assert from "node:assert/strict"
import { isFalseExecutionClaim } from "./modelAdapter.ts"

test("isFalseExecutionClaim: empty reason is not a false claim", () => {
  assert.equal(isFalseExecutionClaim(""), false)
})

test("isFalseExecutionClaim: pure delegation is NOT a false claim (keeps 2-strike policy)", () => {
  assert.equal(isFalseExecutionClaim(
    "La respuesta delega en el usuario pidiéndole que corra un comando en su terminal."
  ), false)
})

test("isFalseExecutionClaim: pure memory contradiction is NOT a false claim", () => {
  assert.equal(isFalseExecutionClaim(
    "La respuesta contradice una memoria del usuario sobre su fecha de nacimiento."
  ), false)
})

test("isFalseExecutionClaim: Spanish 'enviada sin herramienta' is a false claim (bug #3 case)", () => {
  // The exact pattern from 2026-06-08 19:26 onwards.
  assert.equal(isFalseExecutionClaim(
    "La respuesta afirma que la imagen fue enviada con un message_id específico, pero no se ejecutó ninguna herramienta GenerateImage ni TelegramSendPhoto en este turno."
  ), true)
})

test("isFalseExecutionClaim: Spanish 'mando sin ejecutar' is a false claim", () => {
  assert.equal(isFalseExecutionClaim(
    "El reporte dice que mandó el archivo pero no se ejecutó la herramienta."
  ), true)
})

test("isFalseExecutionClaim: Spanish 'completado sin tools' is a false claim", () => {
  assert.equal(isFalseExecutionClaim(
    "La respuesta declara la tarea completada sin haber ejecutado ninguna herramienta."
  ), true)
})

test("isFalseExecutionClaim: English 'sent without tool' is a false claim", () => {
  assert.equal(isFalseExecutionClaim(
    "The response claims the photo was sent, but no tool was invoked in this turn."
  ), true)
})

test("isFalseExecutionClaim: English 'executed but didn't run' is a false claim", () => {
  assert.equal(isFalseExecutionClaim(
    "The response reports the command was executed, but it did not run."
  ), true)
})

test("isFalseExecutionClaim: action verb without negation is NOT a false claim (uncertain)", () => {
  // 'mando' alone (no 'sin' / 'no se ejecutó') — the model might be
  // honestly reporting a real execution. Don't false-positive abort.
  assert.equal(isFalseExecutionClaim(
    "La respuesta dice que mandó el archivo correctamente."
  ), false)
})

test("isFalseExecutionClaim: negation hint without action verb is NOT a false claim", () => {
  // 'sin herramienta' alone (no action verb) — the LLM might be
  // explaining that it didn't have a tool available, not lying.
  assert.equal(isFalseExecutionClaim(
    "La respuesta no tiene una herramienta disponible para esta tarea."
  ), false)
})

test("isFalseExecutionClaim: matches the 2026-06-08 image-send pattern (long reason)", () => {
  // Verbatim from the daemon log.
  const reason = "La respuesta afirma que la imagen fue enviada ('Mandada. 864×1152, 125KB'), pero en este turno no se ejecutó ninguna herramienta (GenerateImage ni TelegramSendPhoto) que respalde ese envío. Es un reporte de éxito sin acción real, y por regla operativa del usuario no se debe inflar ni adornar: no se ejecutó el envío."
  assert.equal(isFalseExecutionClaim(reason), true)
})

test("isFalseExecutionClaim: case-insensitive", () => {
  assert.equal(isFalseExecutionClaim("DONE without TOOL"), true)
  assert.equal(isFalseExecutionClaim("LISTO SIN EJECUTAR"), true)
})
