// -----------------------------------------------------------------------------
// Telegram URL/host guards and lightweight URL probe.
//
// Isolated module so it can be unit-tested without dragging in the full tool
// registry (which has a circular reference bug between file.ts and the
// registry that crashes at module-init time under --experimental-strip-types).
// -----------------------------------------------------------------------------

// Some image CDNs (Reddit, Pinterest, certain Imgur paths) block generic
// bot user-agents with HTTP 403 even when the file is publicly accessible.
// They need a full browser-shaped request (Referer + Accept-Language +
// Sec-Fetch-*) and a Referer that matches a "real" referring page on the
// same site.
const BROWSER_REQUIRED_HOSTS = /(\.|^)(reddit\.com|redd\.it|i\.redd\.it|preview\.redd\.it|b\.thumbs\.redditmedia\.com|pinterest\.com|pinimg\.com|i\.pinimg\.com|imgur\.com|i\.imgur\.com|fbcdn\.net|medium\.com)$/i

export function isBrowserRequiredHost(hostname: string): boolean {
  return BROWSER_REQUIRED_HOSTS.test(hostname.toLowerCase())
}

export function refererForHost(hostname: string): string {
  const h = hostname.toLowerCase()
  if (/(^|\.)(reddit\.com|redd\.it|preview\.redd\.it|b\.thumbs\.redditmedia\.com|i\.redd\.it)$/.test(h)) {
    return "https://www.reddit.com/"
  }
  if (/(^|\.)(pinterest\.com|pinimg\.com|i\.pinimg\.com)$/.test(h)) {
    return "https://www.pinterest.com/"
  }
  if (/(^|\.)(imgur\.com|i\.imgur\.com)$/.test(h)) {
    return "https://imgur.com/"
  }
  if (/(^|\.)(fbcdn\.net)$/.test(h)) {
    return "https://www.facebook.com/"
  }
  if (/(^|\.)(medium\.com)$/.test(h)) {
    return "https://medium.com/"
  }
  return `https://${hostname}/`
}

export function isHtmlContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase()
  return ct.includes("text/html") || ct.includes("application/xhtml")
}

/**
 * Some 403 pages come back as 200 with an HTML login wall. Some API errors
 * come back as 200 with a JSON error body. Detect both so we don't pass the
 * garbage to TelegramSendPhoto.
 */
export function isJsonErrorBody(buffer: Buffer, contentType: string): boolean {
  if (!contentType.toLowerCase().includes("json")) return false
  if (buffer.length === 0 || buffer.length > 4096) return false
  const text = buffer.toString("utf-8", 0, Math.min(buffer.length, 1024)).trim()
  if (!text.startsWith("{")) return false
  try {
    const obj = JSON.parse(text) as Record<string, unknown>
    return "error" in obj || "errors" in obj || "message" in obj && !("ok" in obj)
  } catch {
    return false
  }
}

/**
 * Telegram file_id: base64-like ASCII, 20-100 chars, no slashes, no dots.
 * The Telegram Bot API accepts these directly as `photo` values.
 */
export function looksLikeTelegramFileId(value: string): boolean {
  if (!value) return false
  if (value.length < 12 || value.length > 100) return false
  if (value.includes("/") || value.includes(".") || value.includes(" ")) return false
  return /^[A-Za-z0-9_-]+$/.test(value)
}

/**
 * Lightweight URL probe for TelegramSendPhoto. Returns:
 *   { ok: true }                              when the URL returns a direct image
 *   { ok: false, reason: string }             when the URL is clearly not an image
 *   null                                      when the probe is inconclusive (network error, timeout, etc.)
 *
 * The probe is fail-soft: anything that looks like a transient network problem
 * returns `null` and the caller lets Telegram try the URL itself.
 */
export async function probeImageUrl(url: string): Promise<{ ok: true } | { ok: false; reason: string } | null> {
  let parsed: URL
  try { parsed = new URL(url) } catch { return { ok: false, reason: "not a valid URL" } }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${parsed.protocol}` }
  }
  let response: Response
  try {
    response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "MonolitoV2/1.0" },
    })
    // Some hosts (older CDNs, certain buckets) reject HEAD with 405. Retry
    // with a 1-byte ranged GET so we still get the Content-Type header.
    if (response.status === 405 || response.status === 403) {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(5000),
        headers: {
          "User-Agent": "MonolitoV2/1.0",
          "Range": "bytes=0-0",
        },
      })
    }
  } catch {
    // DNS, timeout, TLS — don't block, let Telegram try.
    return null
  }
  if (response.status >= 400) {
    return { ok: false, reason: `HTTP ${response.status} ${response.statusText}` }
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
  if (isHtmlContentType(contentType)) {
    return { ok: false, reason: `content-type is ${contentType} (HTML page, not a direct image)` }
  }
  if (contentType && !contentType.startsWith("image/")) {
    return { ok: false, reason: `content-type is ${contentType} (not an image)` }
  }
  return { ok: true }
}
