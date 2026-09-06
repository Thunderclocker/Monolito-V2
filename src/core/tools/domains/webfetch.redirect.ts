// WebFetch redirect validation: isPermittedRedirect + followWithPermittedRedirects.
// FC parity: extraído de WebFetch upstream. Same-host+port+registrable-host check.

import { lookup } from "node:dns/promises"
import { isPrivateHost, validateUrlStrict } from "./webfetch-validators.ts"

export const MAX_REDIRECTS = 10

/** Extrae el "registrable domain" (eTLD+1) de un host. Implementación simple. */
export function getRegistrableDomain(host: string): string {
  const parts = host.split(".")
  if (parts.length <= 2) return host
  // Skip "www." prefix
  if (parts[0] === "www" && parts.length > 2) {
    return parts.slice(1).join(".")
  }
  return parts.slice(-2).join(".")
}

export function isPermittedRedirect(fromUrl: string, toUrl: string): boolean {
  try {
    const targetValidation = validateUrlStrict(toUrl)
    if (!targetValidation.valid || targetValidation.url !== toUrl) return false

    const from = new URL(fromUrl)
    const to = new URL(toUrl)
    if (from.protocol !== to.protocol) return false
    if (from.port !== to.port) return false
    if (from.hostname === to.hostname) return true
    // Same registrable domain (e.g. example.com ↔ www.example.com)
    return getRegistrableDomain(from.hostname) === getRegistrableDomain(to.hostname)
  } catch {
    return false
  }
}

type DnsRecord = { address: string; family: number }
type ResolveAll = (hostname: string) => Promise<DnsRecord[]>

const resolveAll: ResolveAll = async hostname => lookup(hostname, { all: true, verbatim: true })

/**
 * Re-resuelve el host inmediatamente antes de cada request y falla cerrado si
 * cualquier respuesta DNS apunta a una red privada/local. Esto cubre nombres
 * públicos que intentan rebindear a loopback, link-local, RFC1918 o IPv6 local.
 */
export async function assertPublicResolvedHost(
  url: string,
  resolver: ResolveAll = resolveAll,
): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol === "data:") return

  const records = await resolver(parsed.hostname.replace(/^\[|\]$/g, ""))
  if (!records.length) throw new Error(`DNS resolution returned no addresses for ${parsed.hostname}`)

  for (const record of records) {
    if (isPrivateHost(record.address)) {
      throw new Error(`DNS resolution for ${parsed.hostname} returned private address ${record.address}`)
    }
  }
}

export type RedirectResult = {
  finalUrl: string
  content: string
  contentType: string
  code: number
  codeText: string
  bytes: number
  redirectCount: number
  lastUrl: string
}

/** Sigue redirects con `fetch` nativo, validando cada uno via isPermittedRedirect. */
export async function followWithPermittedRedirects(
  initialUrl: string,
  options: {
    signal?: AbortSignal
    headers?: Record<string, string>
    timeoutMs?: number
  } = {},
): Promise<RedirectResult> {
  const timeoutMs = options.timeoutMs ?? 15000
  let currentUrl = initialUrl
  let redirectCount = 0
  let lastUrl = initialUrl

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublicResolvedHost(currentUrl)
    const response = await fetch(currentUrl, {
      headers: {
        "User-Agent": "MonolitoV2/1.0",
        "Accept": "application/json,text/html,application/xhtml+xml,text/plain,*/*",
        ...options.headers,
      },
      signal: options.signal ?? AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    })
    lastUrl = currentUrl
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) break
      const nextUrl = new URL(location, currentUrl).toString()
      if (!isPermittedRedirect(currentUrl, nextUrl)) {
        throw new Error(`Redirect from ${currentUrl} to ${nextUrl} blocked: target not permitted`)
      }
      currentUrl = nextUrl
      redirectCount++
      continue
    }
    const buffer = await response.arrayBuffer()
    const decoder = new TextDecoder("utf-8", { fatal: false })
    return {
      finalUrl: currentUrl,
      content: decoder.decode(buffer),
      contentType: response.headers.get("content-type") ?? "",
      code: response.status,
      codeText: response.statusText,
      bytes: buffer.byteLength,
      redirectCount,
      lastUrl,
    }
  }
  throw new Error(`Too many redirects (${MAX_REDIRECTS})`)
}
