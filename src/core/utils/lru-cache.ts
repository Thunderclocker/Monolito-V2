// Generic LRU cache with optional byte-aware eviction and TTL.
// FC parity: extraído del cache de WebFetch (15min TTL) y Bash output limits.

type Entry<V> = {
  value: V
  sizeBytes: number
  expiresAt: number
}

export type LruCacheOptions = {
  maxEntries?: number
  maxBytes?: number
  ttlMs?: number
  sizeOf?: (value: unknown) => number
}

export class LruCache<K, V> {
  private map = new Map<K, Entry<V>>()
  private currentBytes = 0
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly ttlMs: number
  private readonly sizeOf: (value: unknown) => number

  constructor(opts: LruCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? Infinity
    this.maxBytes = opts.maxBytes ?? Infinity
    this.ttlMs = opts.ttlMs ?? Infinity
    this.sizeOf = opts.sizeOf ?? defaultSizeOf
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.evictKey(key)
      return undefined
    }
    // refresh LRU order
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.evictKey(key)
    const sizeBytes = this.sizeOf(value)
    const entry: Entry<V> = { value, sizeBytes, expiresAt: Date.now() + this.ttlMs }
    this.map.set(key, entry)
    this.currentBytes += sizeBytes
    this.evictIfNeeded()
  }

  has(key: K): boolean {
    return this.get(key) !== undefined
  }

  delete(key: K): boolean {
    return this.evictKey(key)
  }

  clear(): void {
    this.map.clear()
    this.currentBytes = 0
  }

  get size(): number {
    return this.map.size
  }

  get bytes(): number {
    return this.currentBytes
  }

  private evictKey(key: K): boolean {
    const entry = this.map.get(key)
    if (!entry) return false
    this.map.delete(key)
    this.currentBytes -= entry.sizeBytes
    return true
  }

  private evictIfNeeded() {
    // TTL first
    const now = Date.now()
    for (const [k, e] of this.map) {
      if (e.expiresAt <= now) this.evictKey(k)
    }
    // size
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.evictKey(oldest)
    }
    while (this.currentBytes > this.maxBytes && this.map.size > 0) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.evictKey(oldest)
    }
  }
}

function defaultSizeOf(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8")
  if (value instanceof Uint8Array) return value.byteLength
  if (value instanceof ArrayBuffer) return value.byteLength
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    return 1024
  }
}
