// Tests for STT probe result classification and message formatting.
//
// Bug #7 (09-jun-2026): The probe loop in deployManagedSttContainer rendered
// every failure (timeout, ECONNREFUSED, DNS error, HTTP 500, etc.) as
// 'no respondió dentro de 300s'. A user whose docker daemon is down would
// wait 5 minutes for a port that's definitely closed. The fix distinguishes
// the cause and bails out of the probe loop early for terminal errors.

import { test } from "node:test"
import assert from "node:assert/strict"
import { formatProbeFailure, type ProbeResult } from "./managed.ts"

test("formatProbeFailure: connection_refused produces 'conexión rechazada'", () => {
  const msg = formatProbeFailure("base", "connection_refused", 300)
  assert.match(msg, /conexión rechazada/i)
  assert.match(msg, /^base:/)
})

test("formatProbeFailure: dns_error produces 'error de DNS'", () => {
  const msg = formatProbeFailure("base", "dns_error", 300)
  assert.match(msg, /DNS/i)
})

test("formatProbeFailure: not_listening produces 'no responde /asr'", () => {
  const msg = formatProbeFailure("base", "not_listening", 300)
  assert.match(msg, /no responde \/asr/)
})

test("formatProbeFailure: timeout preserves the seconds count", () => {
  const msg = formatProbeFailure("base", "timeout", 300)
  assert.match(msg, /300s/)
  assert.match(msg, /timeout/i)
})

test("formatProbeFailure: other produces 'error desconocido'", () => {
  const msg = formatProbeFailure("base", "other", 300)
  assert.match(msg, /desconocido/i)
})

test("formatProbeFailure: model name appears in every message", () => {
  const reasons: ProbeResult["reason"][] = [
    "connection_refused", "dns_error", "not_listening", "timeout", "other",
  ]
  for (const reason of reasons) {
    const msg = formatProbeFailure("small", reason, 300)
    assert.ok(msg.startsWith("small:"), `model name 'small' missing in: ${msg}`)
  }
})

test("formatProbeFailure: includes the actual model that failed (not the request)", () => {
  // The fallback chain may try 'tiny' after 'base' failed. The message
  // must reflect what actually failed, not the original request.
  const msg = formatProbeFailure("tiny", "connection_refused", 300)
  assert.ok(msg.startsWith("tiny:"))
})
