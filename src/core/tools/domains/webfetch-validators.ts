// WebFetch URL validators: validateUrlStrict + HTTPS upgrade.
// upstream parity: extraído de utils.ts upstream.

export const MAX_URL_LENGTH = 2000
export const ALLOWED_PROTOCOLS = new Set(["https:", "http:", "data:"])

export type UrlValidation = {
  valid: boolean
  url?: string
  upgraded: boolean
  reason?: string
}

export function validateUrlStrict(input: string): UrlValidation {
  if (typeof input !== "string") {
    return { valid: false, upgraded: false, reason: "url is not a string" }
  }
  // data: URLs (used for tests/dev) get a higher limit
  const isDataUrl = input.startsWith("data:")
  const limit = isDataUrl ? 1_000_000 : MAX_URL_LENGTH
  if (input.length > limit) {
    return { valid: false, upgraded: false, reason: `url exceeds ${limit} chars` }
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { valid: false, upgraded: false, reason: "url parse failed" }
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { valid: false, upgraded: false, reason: `protocol not allowed: ${url.protocol}` }
  }
  if (url.protocol === "http:") {
    // Upgrade to https
    const upgraded = `https:${url.toString().slice(url.protocol.length)}`
    return { valid: true, url: upgraded, upgraded: true }
  }
  return { valid: true, url: input, upgraded: false }
}

export function isPrivateHost(hostname: string): boolean {
  // RFC 1918 + loopback + link-local
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0") return true
  if (hostname.startsWith("10.")) return true
  if (hostname.startsWith("192.168.")) return true
  if (hostname.startsWith("169.254.")) return true
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true
  // IPv6 private ranges
  if (hostname.startsWith("fc") || hostname.startsWith("fd")) return true
  if (hostname.startsWith("fe80:")) return true
  return false
}
