// Tests para secret-scanner.ts

import test from "node:test"
import assert from "node:assert/strict"
import {
  scanForSecrets,
  scanHighEntropyStrings,
  isSafeToWrite,
  shannonEntropy,
} from "./secret-scanner.ts"

test("shannonEntropy returns 0 for empty string", () => {
  assert.equal(shannonEntropy(""), 0)
})

test("shannonEntropy low for repetitive string", () => {
  const e = shannonEntropy("aaaaaaaaaa")
  assert.ok(e < 1, `expected low entropy, got ${e}`)
})

test("shannonEntropy high for random hex", () => {
  const e = shannonEntropy("a3f9b2e1c4d8f7a2b9c1d3e5f8a4b2c6d9e1f3a5b7c9d2e4f6a8b1c3d5e7f9a2b")
  assert.ok(e > 3, `expected high entropy, got ${e}`)
})

test("scanForSecrets detects AWS access key", () => {
  const content = "AWS_KEY=AKIAIOSFODNN7EXAMPLE"
  const findings = scanForSecrets(content)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].patternId, "aws-access-key")
})

test("scanForSecrets detects GitHub PAT classic", () => {
  const content = "token = ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const findings = scanForSecrets(content)
  assert.ok(findings.some(f => f.patternId === "github-pat-classic"))
})

test("scanForSecrets detects GitHub fine-grained PAT", () => {
  // Fine-grained PATs have exactly 82 chars after "github_pat_"
  const token = "github_pat_" + "A".repeat(82)
  const content = `GITHUB_TOKEN=${token}`
  const findings = scanForSecrets(content)
  assert.ok(findings.some(f => f.patternId === "github-pat-fine-grained"))
})

test("scanForSecrets detects PEM private key header", () => {
  const content = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAA..."
  const findings = scanForSecrets(content)
  assert.ok(findings.some(f => f.patternId === "private-key-pem"))
})

test("scanForSecrets detects JWT", () => {
  const content = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
  const findings = scanForSecrets(content)
  assert.ok(findings.some(f => f.patternId === "jwt-token"))
})

test("scanForSecrets detects Slack bot token", () => {
  const content = "slack_token = xoxb-dummy-token-for-testing"
  const findings = scanForSecrets(content)
  assert.ok(findings.some(f => f.patternId === "slack-bot-token"))
})

test("scanForSecrets returns no findings for clean code", () => {
  const content = `function add(a, b) { return a + b }`
  const findings = scanForSecrets(content)
  assert.equal(findings.length, 0)
})

test("scanHighEntropyStrings detects high-entropy strings", () => {
  const content = "key = abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
  const findings = scanHighEntropyStrings(content)
  assert.ok(findings.length > 0)
  assert.equal(findings[0].patternId, "entropy-high")
})

test("isSafeToWrite returns safe for clean content", () => {
  const r = isSafeToWrite("function hello() { return 'world' }")
  assert.equal(r.safe, true)
  assert.equal(r.findings.length, 0)
})

test("isSafeToWrite returns unsafe on secret pattern", () => {
  const r = isSafeToWrite("api_key = AKIAIOSFODNN7EXAMPLE")
  assert.equal(r.safe, false)
  assert.ok(r.findings.length > 0)
})

test("isSafeToWrite returns unsafe on high-entropy string", () => {
  const r = isSafeToWrite("token: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
  assert.equal(r.safe, false)
})
