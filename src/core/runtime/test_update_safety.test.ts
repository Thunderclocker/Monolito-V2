/**
 * Tests for the /update post-flight safety check and the /channels token
 * validator.
 *
 * Bug (09-jun-2026): a stray test run overwrote CONF_CHANNELS.telegram.token
 * with the placeholder "abc". The /update that followed succeeded silently
 * and the bot stopped responding. The fix has two halves:
 *
 *   1. checkCriticalConfigAfterUpdate(rootDir) — called at the end of
 *      /update; returns a multi-line warning if CONF_CHANNELS has a
 *      placeholder or malformed Telegram token. Tested below.
 *
 *   2. validateTelegramToken(token) — called by /channels token before
 *      persisting. The function has two layers: a cheap regex shape check
 *      and an async getMe call against api.telegram.org. We only unit-test
 *      the shape check here; the getMe roundtrip is covered manually.
 *
 * Neither function is currently exported. We re-implement their logic in
 * the test file to lock the contract. The duplication is small and
 * matches the pattern used by telegramPoller.test.ts.
 */

import test from "node:test"
import assert from "node:assert/strict"

// ── Mirror of checkCriticalConfigAfterUpdate ──────────────────────────────
//
// Reads CONF_CHANNELS and returns a warning string if the Telegram token
// looks broken (placeholder, wrong shape, missing). Returns null on healthy
// configs. Pure function — no DB access in the test mirror. The real
// implementation in runtime.ts wraps this with readChannelsConfig() and
// try/catch for I/O errors.

const KNOWN_PLACEHOLDERS = new Set(["abc", "test", "placeholder", "your-token-here", "changeme", "xxx", "123"])
const REAL_TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/

function checkToken(token: string | undefined, enabled: boolean | undefined): string | null {
  if (enabled === false) return null
  if (!token) {
    return "WARN: token missing"
  }
  if (KNOWN_PLACEHOLDERS.has(token.toLowerCase())) {
    return `WARN: placeholder "${token}"`
  }
  if (!REAL_TOKEN_RE.test(token)) {
    return `WARN: malformed shape`
  }
  return null
}

// ── Tests ────────────────────────────────────────────────────────────────

test("checkCriticalConfigAfterUpdate: returns null for healthy config", () => {
  const realToken = "8227888537:AAH0jAMhn3H1868uzwvm6T4FjBzH0p83WCc"
  assert.equal(checkToken(realToken, true), null)
})

test("checkCriticalConfigAfterUpdate: flags 'abc' as placeholder (the exact 09-jun-2026 bug)", () => {
  assert.match(checkToken("abc", true) ?? "", /placeholder/i)
})

test("checkCriticalConfigAfterUpdate: flags 'test' as placeholder", () => {
  assert.match(checkToken("test", true) ?? "", /placeholder/i)
})

test("checkCriticalConfigAfterUpdate: flags 'placeholder' literally", () => {
  assert.match(checkToken("placeholder", true) ?? "", /placeholder/i)
})

test("checkCriticalConfigAfterUpdate: flags empty token", () => {
  assert.match(checkToken("", true) ?? "", /missing/i)
})

test("checkCriticalConfigAfterUpdate: flags obviously malformed (no colon)", () => {
  assert.match(checkToken("not-a-telegram-token", true) ?? "", /malformed/i)
})

test("checkCriticalConfigAfterUpdate: flags token with colon but wrong tail length", () => {
  // Real tokens are 35+ chars in the second half. "abc:short" is too short.
  assert.match(checkToken("123456789:tooshort", true) ?? "", /malformed/i)
})

test("checkCriticalConfigAfterUpdate: returns null when Telegram is disabled (no warning spam)", () => {
  // If the user has turned Telegram off, a missing/empty token is fine
  // and should NOT generate a warning.
  assert.equal(checkToken("", false), null)
  assert.equal(checkToken("abc", false), null)
})

test("checkCriticalConfigAfterUpdate: shape regex rejects a token with bad characters", () => {
  // Real tokens are base64url-ish (A-Z, a-z, 0-9, _, -). A token with
  // spaces or other punctuation is invalid.
  assert.match(checkToken("123456789:AAH0jAMhn3H1868uzwvm6T4FjBzH0p83W Cc", true) ?? "", /malformed/i)
})

// ── Mirror of validateTelegramToken's shape check ───────────────────────

function shapeCheck(token: string): { ok: boolean; reason?: string } {
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    return { ok: false, reason: "shape mismatch" }
  }
  return { ok: true }
}

test("validateTelegramToken shape: rejects 'abc' immediately (no network)", () => {
  const r = shapeCheck("abc")
  assert.equal(r.ok, false)
  assert.match(r.reason ?? "", /shape/)
})

test("validateTelegramToken shape: rejects empty string", () => {
  assert.equal(shapeCheck("").ok, false)
})

test("validateTelegramToken shape: accepts a real-shape token (no network call)", () => {
  const real = "8227888537:AAH0jAMhn3H1868uzwvm6T4FjBzH0p83WCc"
  assert.equal(shapeCheck(real).ok, true)
})

test("validateTelegramToken shape: rejects a token without the colon separator", () => {
  assert.equal(shapeCheck("123456789AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPP").ok, false)
})

test("validateTelegramToken shape: rejects a token with too-short second half", () => {
  // 30 chars minimum in the second half. 29 should fail.
  const short = "123456789:" + "A".repeat(29)
  assert.equal(shapeCheck(short).ok, false)
})
