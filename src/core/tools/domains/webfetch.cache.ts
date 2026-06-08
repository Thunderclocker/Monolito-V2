// WebFetch LRU cache: per-URL response cache, 15min TTL, 50MB cap, byte-aware eviction.
// FC parity: extraído de WebFetch cache upstream. Usa LruCache de core/utils.

import { LruCache } from "../../utils/lru-cache.ts"

export type CachedFetch = {
  content: string
  contentType: string
  bytes: number
  code: number
  codeText: string
  fetchedAt: number
}

const DEFAULT_TTL_MS = 15 * 60 * 1000  // 15 minutes
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024  // 50 MB

let _cache: LruCache<string, CachedFetch> | null = null

function getCache(): LruCache<string, CachedFetch> {
  if (!_cache) {
    _cache = new LruCache<string, CachedFetch>({
      maxEntries: 1000,
      maxBytes: DEFAULT_MAX_BYTES,
      ttlMs: DEFAULT_TTL_MS,
      sizeOf: (v: unknown) => (v as CachedFetch).bytes,
    })
  }
  return _cache
}

/** Cache hit para URL exacta. */
export function getCachedFetch(url: string): CachedFetch | undefined {
  return getCache().get(url)
}

/** Cache miss: almacenar respuesta. */
export function setCachedFetch(url: string, fetch: CachedFetch): void {
  getCache().set(url, fetch)
}

/** Invalida cache de un URL específico. */
export function invalidateCachedFetch(url: string): boolean {
  return getCache().delete(url)
}

/** Invalida toda la cache. */
export function clearWebFetchCache(): void {
  getCache().clear()
}

/** Estadísticas de la cache (testing). */
export function getWebFetchCacheStats(): { size: number; bytes: number } {
  return { size: getCache().size, bytes: getCache().bytes }
}
