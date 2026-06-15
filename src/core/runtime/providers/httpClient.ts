const keepAliveAgents = new Map<string, boolean>()

function rememberOrigin(url: string | URL) {
  try {
    const origin = new URL(url.toString()).origin
    keepAliveAgents.set(origin, true)
  } catch {
    // Ignore invalid URLs.
  }
}

/** fetch wrapper that enables HTTP keep-alive when supported by the runtime. */
export function pooledFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  rememberOrigin(url)
  return fetch(url, {
    ...init,
    keepalive: true,
  })
}

export function releaseHttpClients() {
  keepAliveAgents.clear()
}

export function getPooledFetchOrigins() {
  return [...keepAliveAgents.keys()]
}
