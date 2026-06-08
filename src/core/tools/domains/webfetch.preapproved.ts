// WebFetch preapproved hosts: subset curado de hosts de confianza con path-prefix
// segment boundary matching.
// FC parity: extraído de preapproved.ts upstream.

export type PreapprovedHost = {
  host: string
  /** Etiqueta legible (para logs / debug). */
  label: string
}

const PREAPPROVED_HOSTS: PreapprovedHost[] = [
  { host: "developer.mozilla.org", label: "MDN" },
  { host: "mdn.io", label: "MDN redirect" },
  { host: "developer.mozilla.com", label: "MDN (alt domain)" },
  { host: "www.npmjs.com", label: "npm registry" },
  { host: "npmjs.com", label: "npm registry (alt)" },
  { host: "docs.npmjs.com", label: "npm docs" },
  { host: "registry.npmjs.org", label: "npm registry API" },
  { host: "pypi.org", label: "PyPI" },
  { host: "www.python.org", label: "Python docs" },
  { host: "docs.python.org", label: "Python docs" },
  { host: "github.com", label: "GitHub" },
  { host: "api.github.com", label: "GitHub API" },
  { host: "raw.githubusercontent.com", label: "GitHub raw" },
  { host: "stackoverflow.com", label: "Stack Overflow" },
  { host: "www.rfc-editor.org", label: "RFC editor" },
  { host: "datatracker.ietf.org", label: "IETF datatracker" },
  { host: "man7.org", label: "man7 (Linux man pages)" },
  { host: "www.postgresql.org", label: "PostgreSQL docs" },
  { host: "dev.mysql.com", label: "MySQL docs" },
  { host: "redis.io", label: "Redis docs" },
]

const PREAPPROVED_SET = new Set(PREAPPROVED_HOSTS.map(h => h.host))

export function getPreapprovedHosts(): readonly PreapprovedHost[] {
  return PREAPPROVED_HOSTS
}

export function isPreapprovedHost(host: string): boolean {
  if (PREAPPROVED_SET.has(host)) return true
  // Strip www. and re-check
  if (host.startsWith("www.")) {
    return PREAPPROVED_SET.has(host.slice(4))
  }
  return false
}

export function isPreapprovedUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return isPreapprovedHost(u.hostname)
  } catch {
    return false
  }
}
