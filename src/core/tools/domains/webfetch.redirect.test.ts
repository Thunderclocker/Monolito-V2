// Tests para webfetch.redirect.ts y webfetch.preapproved.ts

import test from "node:test"
import assert from "node:assert/strict"
import {
  isPermittedRedirect,
  getRegistrableDomain,
  MAX_REDIRECTS,
} from "./webfetch.redirect.ts"
import { isPreapprovedHost, isPreapprovedUrl, getPreapprovedHosts } from "./webfetch.preapproved.ts"

test("getRegistrableDomain: simple domain", () => {
  assert.equal(getRegistrableDomain("example.com"), "example.com")
  assert.equal(getRegistrableDomain("www.example.com"), "example.com")
  assert.equal(getRegistrableDomain("api.example.com"), "example.com")
  assert.equal(getRegistrableDomain("deep.api.example.com"), "example.com")
})

test("isPermittedRedirect: same host", () => {
  assert.equal(isPermittedRedirect("https://example.com/a", "https://example.com/b"), true)
})

test("isPermittedRedirect: same host different port blocked", () => {
  assert.equal(isPermittedRedirect("https://example.com:443/a", "https://example.com:8080/b"), false)
})

test("isPermittedRedirect: same registrable domain (www vs non-www)", () => {
  assert.equal(isPermittedRedirect("https://www.example.com/a", "https://example.com/b"), true)
  assert.equal(isPermittedRedirect("https://example.com/a", "https://www.example.com/b"), true)
})

test("isPermittedRedirect: cross-host blocked", () => {
  assert.equal(isPermittedRedirect("https://example.com/a", "https://evil.com/b"), false)
})

test("isPermittedRedirect: different protocol blocked", () => {
  assert.equal(isPermittedRedirect("https://example.com/a", "http://example.com/b"), false)
})

test("isPermittedRedirect: private redirect targets blocked", () => {
  assert.equal(isPermittedRedirect("https://example.com/a", "https://127.0.0.1/admin"), false)
  assert.equal(isPermittedRedirect("https://example.com/a", "https://169.254.169.254/latest/meta-data"), false)
  assert.equal(isPermittedRedirect("https://example.com/a", "https://[::1]/admin"), false)
})

test("isPermittedRedirect: invalid URLs", () => {
  assert.equal(isPermittedRedirect("not a url", "https://example.com"), false)
  assert.equal(isPermittedRedirect("https://example.com", "not a url"), false)
})

test("MAX_REDIRECTS is 10", () => {
  assert.equal(MAX_REDIRECTS, 10)
})

test("isPreapprovedHost: known hosts", () => {
  assert.equal(isPreapprovedHost("developer.mozilla.org"), true)
  assert.equal(isPreapprovedHost("github.com"), true)
  assert.equal(isPreapprovedHost("stackoverflow.com"), true)
  assert.equal(isPreapprovedHost("www.npmjs.com"), true)
  assert.equal(isPreapprovedHost("registry.npmjs.org"), true)
})

test("isPreapprovedHost: www-stripping", () => {
  assert.equal(isPreapprovedHost("www.developer.mozilla.org"), true)
})

test("isPreapprovedHost: unknown hosts", () => {
  assert.equal(isPreapprovedHost("evil.com"), false)
  assert.equal(isPreapprovedHost("malicious-site.io"), false)
  assert.equal(isPreapprovedHost(""), false)
})

test("isPreapprovedUrl: full URL", () => {
  assert.equal(isPreapprovedUrl("https://developer.mozilla.org/en-US/docs/Web/JavaScript"), true)
  assert.equal(isPreapprovedUrl("https://evil.com/payload"), false)
})

test("isPreapprovedUrl: invalid URL", () => {
  assert.equal(isPreapprovedUrl("not a url"), false)
})

test("getPreapprovedHosts returns the list", () => {
  const hosts = getPreapprovedHosts()
  assert.ok(hosts.length > 10)
  assert.ok(hosts.some(h => h.host === "github.com"))
})
