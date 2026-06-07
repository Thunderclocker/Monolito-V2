// Tests para lru-cache.ts

import test from "node:test"
import assert from "node:assert/strict"
import { LruCache } from "./lru-cache.ts"

test("basic set and get", () => {
  const c = new LruCache<string, number>({ maxEntries: 3 })
  c.set("a", 1)
  c.set("b", 2)
  assert.equal(c.get("a"), 1)
  assert.equal(c.get("b"), 2)
  assert.equal(c.get("missing"), undefined)
  assert.equal(c.size, 2)
})

test("LRU eviction by maxEntries", () => {
  const c = new LruCache<string, number>({ maxEntries: 2 })
  c.set("a", 1)
  c.set("b", 2)
  c.set("c", 3)
  assert.equal(c.get("a"), undefined, "a should be evicted")
  assert.equal(c.get("b"), 2)
  assert.equal(c.get("c"), 3)
  // touch b to make it MRU
  c.get("b")
  c.set("d", 4)
  assert.equal(c.get("b"), 2, "b should still be present after touch")
  assert.equal(c.get("c"), undefined, "c should be evicted")
})

test("LRU eviction by maxBytes", () => {
  const c = new LruCache<string, string>({ maxBytes: 20, sizeOf: (v: unknown) => (v as string).length })
  c.set("a", "12345") // 5 bytes
  c.set("b", "1234567890") // 10 bytes
  c.set("c", "123") // 3 bytes → total 18, still under 20
  assert.equal(c.size, 3)
  c.set("d", "12345") // +5 = 23, evicts a
  assert.equal(c.get("a"), undefined, "a should be evicted (oldest)")
  assert.equal(c.get("d"), "12345")
})

test("TTL expiration", async () => {
  const c = new LruCache<string, number>({ ttlMs: 50 })
  c.set("a", 1)
  assert.equal(c.get("a"), 1)
  await new Promise(r => setTimeout(r, 80))
  assert.equal(c.get("a"), undefined, "a should be expired")
})

test("delete and clear", () => {
  const c = new LruCache<string, number>()
  c.set("a", 1)
  c.set("b", 2)
  assert.equal(c.delete("a"), true)
  assert.equal(c.delete("nonexistent"), false)
  assert.equal(c.get("a"), undefined)
  c.clear()
  assert.equal(c.size, 0)
  assert.equal(c.get("b"), undefined)
})

test("default sizeOf handles strings, arrays, and JSON", () => {
  const c = new LruCache<string, unknown>()
  c.set("s", "hello")
  c.set("n", 42)
  c.set("o", { a: 1 })
  assert.equal(c.size, 3)
  assert.ok(c.bytes > 0)
})

test("get refreshes LRU order", () => {
  const c = new LruCache<string, number>({ maxEntries: 2 })
  c.set("a", 1)
  c.set("b", 2)
  c.get("a") // touch
  c.set("c", 3) // would evict oldest (a is now MRU, so b is LRU)
  assert.equal(c.get("a"), 1, "a should remain (touched)")
  assert.equal(c.get("b"), undefined, "b should be evicted")
  assert.equal(c.get("c"), 3)
})
