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
  if (url.protocol !== "data:" && isPrivateHost(url.hostname)) {
    return { valid: false, upgraded: false, reason: `private host not allowed: ${url.hostname}` }
  }
  if (url.protocol === "http:") {
    // Upgrade to https
    const upgraded = `https:${url.toString().slice(url.protocol.length)}`
    return { valid: true, url: upgraded, upgraded: true }
  }
  return { valid: true, url: input, upgraded: false }
}

export function isPrivateHost(hostname: string): boolean {
  // Normalize URL.hostname IPv6 bracket form and case.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")

  // RFC 1918 + loopback + link-local + unspecified IPv4.
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true
  if (/^127\./.test(host)) return true
  if (/^0\./.test(host)) return true
  if (host.startsWith("10.")) return true
  if (host.startsWith("192.168.")) return true
  if (host.startsWith("169.254.")) return true
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true

  // IPv6 unique-local and link-local ranges.
  if (host.startsWith("fc") || host.startsWith("fd")) return true
  if (host.startsWith("fe80:")) return true
  return false
}
