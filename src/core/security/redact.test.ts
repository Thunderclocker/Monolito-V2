import test from "node:test"
import assert from "node:assert/strict"
import { redactSensitiveText, redactSensitiveValue } from "./redact.ts"

test("redactSensitiveText masks Brave and Tavily search keys", () => {
  const brave = "la api es BSAYcJPXJ9LetUlprVYPBRjXuwsuwUR"
  assert.equal(redactSensitiveText(brave), "la api es [REDACTED]")
  assert.equal(redactSensitiveText("key tvly-abc123xyz4567890 here"), "key [REDACTED] here")
})

test("redactSensitiveText masks PEM private keys", () => {
  const pem = "prefix -----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY----- suffix"
  assert.equal(redactSensitiveText(pem), "prefix [REDACTED] suffix")
})

test("redactSensitiveValue masks camelCase secret keys", () => {
  assert.deepEqual(
    redactSensitiveValue({ clientSecret: "abc", privateKey: "def", sessionToken: "ghi", safe: "ok" }),
    { clientSecret: "[REDACTED]", privateKey: "[REDACTED]", sessionToken: "[REDACTED]", safe: "ok" },
  )
})

test("redactSensitiveValue preserves cycles without recursion failure", () => {
  const input: { name: string; token: string; self?: unknown } = { name: "root", token: "secret" }
  input.self = input
  const output = redactSensitiveValue(input)
  assert.equal(output.token, "[REDACTED]")
  assert.equal(output.self, output)
})
