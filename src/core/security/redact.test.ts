import test from "node:test"
import assert from "node:assert/strict"
import { redactSensitiveText } from "./redact.ts"

test("redactSensitiveText masks Brave and Tavily search keys", () => {
  const brave = "la api es BSAYcJPXJ9LetUlprVYPBRjXuwsuwUR"
  assert.equal(redactSensitiveText(brave), "la api es [REDACTED]")
  assert.equal(redactSensitiveText("key tvly-abc123xyz4567890 here"), "key [REDACTED] here")
})
