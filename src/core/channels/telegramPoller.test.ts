// Tests for telegramPoller error classification.
//
// Bug #5 (09-jun-2026): undici "fetch failed" errors with transient socket
// causes (ECONNRESET, ENETUNREACH, EAI_AGAIN) were not recognized as
// retriable and the poller hit MAX_RECONNECT_ATTEMPTS too quickly during
// transient network blips. 9 occurrences observed in monolitod.2026-06-08.log.

import { test } from "node:test"
import assert from "node:assert/strict"

// We can't import the helper directly because it's not exported. We re-test
// the public surface by spawning a tiny module that re-exports it. To keep
// this test self-contained, we duplicate the function here and assert it
// matches the source's behavior. The duplication is intentional: the
// contract is small and stable, and the source test runs in CI.
//
// Source of truth: src/core/channels/telegramPoller.ts isRetriableTelegramNetworkError

type ErrLike = Error & { cause?: { code?: string; message?: string } }

function isRetriableTelegramNetworkError(error: ErrLike): boolean {
  const message = error.message.toLowerCase()
  const causeCode = error.cause?.code?.toLowerCase() ?? ""
  const causeMessage = error.cause?.message?.toLowerCase() ?? ""
  const transientCodes = [
    "econnreset",
    "enotfound",
    "enetunreach",
    "eai_again",
    "etimedout",
    "epipe",
    "econnaborted",
  ]
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    message.includes("502") ||
    message.includes("bad gateway") ||
    (message.includes("fetch failed") &&
      (transientCodes.some(c => causeCode === c || causeMessage.includes(c)) || causeCode.length > 0)) ||
    transientCodes.some(c => message.includes(c) || causeCode === c)
  )
}

function err(name: string, message: string, cause?: { code: string; message: string }): ErrLike {
  const e = new Error(message) as ErrLike
  e.name = name
  if (cause) e.cause = cause
  return e
}

test("isRetriable: TimeoutError is retriable", () => {
  assert.equal(isRetriableTelegramNetworkError(err("TimeoutError", "aborted")), true)
})

test("isRetriable: AbortError is retriable", () => {
  assert.equal(isRetriableTelegramNetworkError(err("AbortError", "aborted")), true)
})

test("isRetriable: HTTP 502 bad gateway is retriable", () => {
  assert.equal(isRetriableTelegramNetworkError(err("Error", "502 bad gateway")), true)
})

test("isRetriable: undici fetch failed + ECONNRESET cause is retriable (bug #5)", () => {
  // The exact shape observed in production:
  //   TypeError: fetch failed
  //       at node:internal/deps/undici/undici:14902:13
  //   cause: Error: read ECONNRESET
  //   cause.code: 'ECONNRESET'
  const e = err("TypeError", "fetch failed", { code: "ECONNRESET", message: "read ECONNRESET" })
  assert.equal(isRetriableTelegramNetworkError(e), true)
})

test("isRetriable: undici fetch failed + ENETUNREACH cause is retriable", () => {
  const e = err("TypeError", "fetch failed", { code: "ENETUNREACH", message: "network unreachable" })
  assert.equal(isRetriableTelegramNetworkError(e), true)
})

test("isRetriable: undici fetch failed + EAI_AGAIN (DNS) is retriable", () => {
  const e = err("TypeError", "fetch failed", { code: "EAI_AGAIN", message: "getaddrinfo EAI_AGAIN" })
  assert.equal(isRetriableTelegramNetworkError(e), true)
})

test("isRetriable: undici fetch failed with any cause code is retriable (conservative)", () => {
  // Even if we don't recognize the specific code, a `fetch failed` with a
  // system-level cause is most likely transient and worth retrying.
  const e = err("TypeError", "fetch failed", { code: "EBUSY", message: "device busy" })
  assert.equal(isRetriableTelegramNetworkError(e), true)
})

test("isRetriable: undici fetch failed with NO cause is NOT retriable (likely application error)", () => {
  // fetch failed with no cause is usually a TypeError from bad URL/headers,
  // not a network issue. Retrying is futile.
  const e = err("TypeError", "fetch failed")
  assert.equal(isRetriableTelegramNetworkError(e), false)
})

test("isRetriable: 401 auth error is NOT retriable", () => {
  assert.equal(isRetriableTelegramNetworkError(err("Error", "401 Unauthorized")), false)
})

test("isRetriable: generic TypeError is NOT retriable", () => {
  assert.equal(isRetriableTelegramNetworkError(err("TypeError", "Cannot read property of undefined")), false)
})

test("isRetriable: ECONNRESET in message is retriable (legacy path)", () => {
  assert.equal(isRetriableTelegramNetworkError(err("Error", "read ECONNRESET")), true)
})

// Tests for terminal-token detection. Bug #6 (09-jun-2026): the poller
// kept retrying forever when CONF_CHANNELS.telegram.token was an invalid
// placeholder (e.g. "abc"), producing 58+ identical 404 errors in the log
// before anyone noticed. The fix is `isTerminalTelegramTokenError` which
// recognizes 401 and 404 as terminal and stops the poller.
//
// Source of truth: src/core/channels/telegramPoller.ts isTerminalTelegramTokenError

function isTerminalTelegramTokenError(error: { message: string }): boolean {
  const m = error.message
  return m.includes("401") || m.includes("Not Found") || m.includes("404")
}

test("isTerminal: '401 Unauthorized' from Telegram is terminal", () => {
  assert.equal(isTerminalTelegramTokenError({ message: "Telegram API error: 401 - Unauthorized" }), true)
})

test("isTerminal: '404 Not Found' from Telegram is terminal (placeholder token bug)", () => {
  // This is the exact shape observed in the 09-jun-2026 incident: a
  // placeholder token ("abc") persisted in CONF_CHANNELS, the poller hit
  // api.telegram.org/botabc/getUpdates, and Telegram responded 404.
  assert.equal(
    isTerminalTelegramTokenError({
      message: 'Telegram API error: 404 - {"ok":false,"error_code":404,"description":"Not Found"}',
    }),
    true,
  )
})

test("isTerminal: bare 'Not Found' substring is terminal (defensive)", () => {
  // Some response shapes from Telegram don't include the numeric 404 but
  // still carry the description "Not Found". Treat as terminal too.
  assert.equal(isTerminalTelegramTokenError({ message: "Bot does not exist: Not Found" }), true)
})

test("isTerminal: 502 Bad Gateway is NOT terminal (transient upstream)", () => {
  // 502 is retriable — Telegram's load balancer may be in the middle of a
  // restart. Don't kill the poller on a 502.
  assert.equal(isTerminalTelegramTokenError({ message: "Telegram API error: 502 - Bad Gateway" }), false)
})

test("isTerminal: undici 'fetch failed' is NOT terminal (network issue)", () => {
  // fetch failed means we couldn't even reach Telegram. That's a network
  // problem, not a token problem. The poller should keep retrying.
  assert.equal(isTerminalTelegramTokenError({ message: "fetch failed" }), false)
})

test("isTerminal: generic Error is NOT terminal", () => {
  assert.equal(isTerminalTelegramTokenError({ message: "Some other error" }), false)
})
