// Tests para websearch/filter-translation.ts

import test from "node:test"
import assert from "node:assert/strict"
import { translateFilters, domainFilterValid } from "./filter-translation.ts"

test("translateFilters: brave silently ignores", () => {
  const r = translateFilters("brave", "https://api.brave.com/search", "test", { allowed: ["example.com"] })
  assert.match(r.url, /q=test/)
  assert.equal(r.warning, "Brave does not support domain filters")
})

test("translateFilters: serper allowed inline", () => {
  const r = translateFilters("serper", "https://serper.dev/search", "test", { allowed: ["stackoverflow.com"] })
  assert.match(r.url, /site%3Astackoverflow\.com/)
})

test("translateFilters: tavily postBody", () => {
  const r = translateFilters("tavily", "https://api.tavily.com/search", "test", { allowed: ["github.com"] })
  assert.deepEqual(r.postBody?.include_domains, ["github.com"])
})

test("translateFilters: tavily exclude_domains", () => {
  const r = translateFilters("tavily", "https://api.tavily.com/search", "test", { blocked: ["evil.com", "spam.com"] })
  assert.deepEqual(r.postBody?.exclude_domains, ["evil.com", "spam.com"])
})

test("translateFilters: default provider warns", () => {
  const r = translateFilters("default", "https://x.com/search", "test", { allowed: ["a.com"] })
  assert.equal(r.warning, "Provider does not support domain filters")
})

test("translateFilters: no filter, no warning", () => {
  const r = translateFilters("brave", "https://x.com/search", "test", {})
  assert.equal(r.warning, undefined)
})

test("domainFilterValid: both set invalid", () => {
  const r = domainFilterValid({ allowed: ["a.com"], blocked: ["b.com"] })
  assert.equal(r.valid, false)
  assert.match(r.reason!, /mutually exclusive/)
})

test("domainFilterValid: empty allowed invalid", () => {
  const r = domainFilterValid({ allowed: [] })
  assert.equal(r.valid, false)
})

test("domainFilterValid: only allowed valid", () => {
  const r = domainFilterValid({ allowed: ["a.com"] })
  assert.equal(r.valid, true)
})

test("domainFilterValid: only blocked valid", () => {
  const r = domainFilterValid({ blocked: ["b.com"] })
  assert.equal(r.valid, true)
})

test("domainFilterValid: no filter valid", () => {
  const r = domainFilterValid({})
  assert.equal(r.valid, true)
})
