// Tests for the URL/host guards and the lightweight URL probe added in
// 2026-06 to prevent the TelegramSendPhoto "wrong type of the web page
// content" incident. Pure helpers + a mocked fetch for probeImageUrl.

import test from "node:test"
import assert from "node:assert/strict"
import {
  isBrowserRequiredHost,
  refererForHost,
  isHtmlContentType,
  isJsonErrorBody,
  looksLikeTelegramFileId,
  probeImageUrl,
} from "./telegramGuards.ts"

test("isBrowserRequiredHost: matches Reddit, Pinterest, Imgur, Facebook, Medium", () => {
  assert.equal(isBrowserRequiredHost("preview.redd.it"), true)
  assert.equal(isBrowserRequiredHost("i.redd.it"), true)
  assert.equal(isBrowserRequiredHost("b.thumbs.redditmedia.com"), true)
  assert.equal(isBrowserRequiredHost("i.pinimg.com"), true)
  assert.equal(isBrowserRequiredHost("pinimg.com"), true)
  assert.equal(isBrowserRequiredHost("i.imgur.com"), true)
  assert.equal(isBrowserRequiredHost("scontent.fbcdn.net"), true)
  assert.equal(isBrowserRequiredHost("cdn-images-1.medium.com"), true)
})

test("isBrowserRequiredHost: does not match generic CDNs", () => {
  assert.equal(isBrowserRequiredHost("example.com"), false)
  assert.equal(isBrowserRequiredHost("images.unsplash.com"), false)
  assert.equal(isBrowserRequiredHost("cdn.jsdelivr.net"), false)
})

test("refererForHost: returns the right Referer for each known family", () => {
  assert.equal(refererForHost("preview.redd.it"), "https://www.reddit.com/")
  assert.equal(refererForHost("i.pinimg.com"), "https://www.pinterest.com/")
  assert.equal(refererForHost("i.imgur.com"), "https://imgur.com/")
  assert.equal(refererForHost("scontent.fbcdn.net"), "https://www.facebook.com/")
  assert.equal(refererForHost("cdn-images-1.medium.com"), "https://medium.com/")
})

test("refererForHost: falls back to https://<host>/ for unknown hosts", () => {
  assert.equal(refererForHost("example.com"), "https://example.com/")
})

test("isHtmlContentType: flags text/html and application/xhtml", () => {
  assert.equal(isHtmlContentType("text/html"), true)
  assert.equal(isHtmlContentType("text/html; charset=utf-8"), true)
  assert.equal(isHtmlContentType("application/xhtml+xml"), true)
  assert.equal(isHtmlContentType("image/jpeg"), false)
  assert.equal(isHtmlContentType("application/octet-stream"), false)
})

test("isJsonErrorBody: flags common API error JSON shapes", () => {
  const errorBuffer = Buffer.from('{"error": "rate limited"}', "utf-8")
  const errorsBuffer = Buffer.from('{"errors": ["x"]}', "utf-8")
  const okBuffer = Buffer.from('{"ok": true, "id": 1}', "utf-8")
  assert.equal(isJsonErrorBody(errorBuffer, "application/json"), true)
  assert.equal(isJsonErrorBody(errorsBuffer, "application/json"), true)
  assert.equal(isJsonErrorBody(okBuffer, "application/json"), false)
})

test("isJsonErrorBody: returns false for non-JSON content-type", () => {
  const html = Buffer.from("<html><body>error</body></html>", "utf-8")
  assert.equal(isJsonErrorBody(html, "text/html"), false)
})

test("looksLikeTelegramFileId: accepts plausible ids", () => {
  assert.equal(looksLikeTelegramFileId("AgACAgIAAxkBAAI"), true)
  assert.equal(looksLikeTelegramFileId("BAACAgIAAxkBAAI6Z2eK4yZ2eK4yZ2eK4y"), true)
})

test("looksLikeTelegramFileId: rejects URLs and short strings", () => {
  assert.equal(looksLikeTelegramFileId("https://example.com/photo.jpg"), false)
  assert.equal(looksLikeTelegramFileId(""), false)
  assert.equal(looksLikeTelegramFileId("short"), false)
  assert.equal(looksLikeTelegramFileId("/path/to/file.jpg"), false)
})

// ---- probeImageUrl with mocked fetch ------------------------------------

function mockFetchOnce(status: number, headers: Record<string, string>, body?: string) {
  return async (_url: string, init?: RequestInit) => {
    return new Response(body ?? null, { status, headers })
  }
}

test("probeImageUrl: returns ok:true for image content-type", async () => {
  const original = globalThis.fetch
  globalThis.fetch = mockFetchOnce(200, { "content-type": "image/jpeg" }) as typeof fetch
  try {
    const r = await probeImageUrl("https://i.imgur.com/abc.jpg")
    assert.deepEqual(r, { ok: true })
  } finally { globalThis.fetch = original }
})

test("probeImageUrl: returns ok:false for HTML login page", async () => {
  const original = globalThis.fetch
  globalThis.fetch = mockFetchOnce(200, { "content-type": "text/html" }) as typeof fetch
  try {
    const r = await probeImageUrl("https://example.com/photo.jpg")
    assert.ok(r && r.ok === false)
    assert.match(r.reason, /HTML/)
  } finally { globalThis.fetch = original }
})

test("probeImageUrl: returns ok:false for non-image content-type", async () => {
  const original = globalThis.fetch
  globalThis.fetch = mockFetchOnce(200, { "content-type": "application/json" }) as typeof fetch
  try {
    const r = await probeImageUrl("https://api.example.com/file")
    assert.ok(r && r.ok === false)
    assert.match(r.reason, /not an image/)
  } finally { globalThis.fetch = original }
})

test("probeImageUrl: returns ok:false for HTTP 403 (host blocked)", async () => {
  const original = globalThis.fetch
  globalThis.fetch = mockFetchOnce(403, {}) as typeof fetch
  try {
    const r = await probeImageUrl("https://preview.redd.it/abc.jpg")
    assert.ok(r && r.ok === false)
    assert.match(r.reason, /403/)
  } finally { globalThis.fetch = original }
})

test("probeImageUrl: returns null on network error (fail-soft)", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED") }) as typeof fetch
  try {
    const r = await probeImageUrl("https://unreachable.example.com/photo.jpg")
    assert.equal(r, null)
  } finally { globalThis.fetch = original }
})

test("probeImageUrl: returns ok:false for non-HTTP protocols", async () => {
  const r = await probeImageUrl("ftp://example.com/photo.jpg")
  assert.ok(r && r.ok === false)
  assert.match(r.reason, /unsupported protocol/)
})
