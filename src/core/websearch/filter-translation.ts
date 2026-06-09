// WebSearch filter translation per provider.
// FC parity: subset del search upstream. Transforma allowed_domains y
// blocked_domains a parámetros específicos de cada provider.

export type DomainFilter = {
  allowed?: string[]
  blocked?: string[]
}

export type Provider = "brave" | "serper" | "tavily" | "default"

export type TranslatedQuery = {
  url: string
  headers?: Record<string, string>
  postBody?: Record<string, unknown>
  warning?: string
}

/** Transforma filtros de dominio a parámetros del provider. */
export function translateFilters(
  provider: Provider,
  baseUrl: string,
  query: string,
  filter: DomainFilter,
  extraParams: Record<string, string> = {},
): TranslatedQuery {
  if (provider === "brave") {
    // Brave: silent ignore domain filters per FC parity
    const url = `${baseUrl}?q=${encodeURIComponent(query)}${Object.entries(extraParams).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join("")}`
    const warning = (filter.allowed || filter.blocked) ? "Brave does not support domain filters" : undefined
    return { url, warning }
  }
  if (provider === "serper") {
    // Serper: site:filter inline + domain param
    let processedQuery = query
    if (filter.allowed && filter.allowed.length > 0) {
      const sites = filter.allowed.map(d => `site:${d}`).join(" OR ")
      processedQuery = `${query} (${sites})`
    } else if (filter.blocked && filter.blocked.length > 0) {
      const sites = filter.blocked.map(d => `-site:${d}`).join(" ")
      processedQuery = `${query} ${sites}`
    }
    const url = `${baseUrl}?q=${encodeURIComponent(processedQuery)}${Object.entries(extraParams).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join("")}`
    return { url }
  }
  if (provider === "tavily") {
    // Tavily: include_domains / exclude_domains in postBody
    const url = baseUrl
    const postBody: Record<string, unknown> = { query, ...extraParams }
    if (filter.allowed && filter.allowed.length > 0) {
      postBody.include_domains = filter.allowed
    }
    if (filter.blocked && filter.blocked.length > 0) {
      postBody.exclude_domains = filter.blocked
    }
    return { url, postBody }
  }
  // default: no filter support
  const url = `${baseUrl}?q=${encodeURIComponent(query)}${Object.entries(extraParams).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join("")}`
  const warning = (filter.allowed || filter.blocked) ? "Provider does not support domain filters" : undefined
  return { url, warning }
}

export function domainFilterValid(filter: DomainFilter): { valid: boolean; reason?: string } {
  if (filter.allowed && filter.blocked) {
    return { valid: false, reason: "allowed_domains and blocked_domains are mutually exclusive" }
  }
  if (filter.allowed && filter.allowed.length === 0) {
    return { valid: false, reason: "allowed_domains must not be empty" }
  }
  if (filter.blocked && filter.blocked.length === 0) {
    return { valid: false, reason: "blocked_domains must not be empty" }
  }
  return { valid: true }
}
