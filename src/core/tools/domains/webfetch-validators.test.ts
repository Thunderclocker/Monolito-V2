// Tests para webfetch-validators.ts

import test from "node:test"
import assert from "node:assert/strict"
import {
  validateUrlStrict,
  isPrivateHost,
  MAX_URL_LENGTH,
} from "./webfetch-validators.ts"

test("validateUrlStrict: valid https", () => {
  const r = validateUrlStrict("https://example.com/path")
  assert.equal(r.valid, true)
  assert.equal(r.upgraded, false)
  assert.equal(r.url, "https://example.com/path")
})

test("validateUrlStrict: http upgrades to https", () => {
  const r = validateUrlStrict("http://example.com/path")
  assert.equal(r.valid, true)
  assert.equal(r.upgraded, true)
  assert.equal(r.url, "https://example.com/path")
})

test("validateUrlStrict: invalid protocol", () => {
  const r = validateUrlStrict("file:///etc/passwd")
  assert.equal(r.valid, false)
  assert.match(r.reason!, /protocol/)
})

test("validateUrlStrict: malformed URL", () => {
  const r = validateUrlStrict("not a url")
  assert.equal(r.valid, false)
})

test("validateUrlStrict: too long", () => {
  const long = "https://example.com/" + "a".repeat(MAX_URL_LENGTH)
  const r = validateUrlStrict(long)
  assert.equal(r.valid, false)
  assert.match(r.reason!, /exceeds/)
})

test("isPrivateHost: localhost", () => {
  assert.equal(isPrivateHost("localhost"), true)
})

test("isPrivateHost: 127.0.0.1", () => {
  assert.equal(isPrivateHost("127.0.0.1"), true)
})

test("isPrivateHost: 10.x", () => {
  assert.equal(isPrivateHost("10.0.0.1"), true)
  assert.equal(isPrivateHost("10.255.255.255"), true)
})

test("isPrivateHost: 192.168.x", () => {
  assert.equal(isPrivateHost("192.168.1.1"), true)
})

test("isPrivateHost: 172.16-31.x", () => {
  assert.equal(isPrivateHost("172.16.0.1"), true)
  assert.equal(isPrivateHost("172.31.255.255"), true)
  assert.equal(isPrivateHost("172.15.0.1"), false)
  assert.equal(isPrivateHost("172.32.0.1"), false)
})

test("isPrivateHost: public host", () => {
  assert.equal(isPrivateHost("github.com"), false)
  assert.equal(isPrivateHost("8.8.8.8"), false)
})
