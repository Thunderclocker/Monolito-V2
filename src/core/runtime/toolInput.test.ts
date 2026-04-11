import test from "node:test"
import assert from "node:assert/strict"
import { normalizeToolInputPayload } from "./toolInput.ts"

test("normalizeToolInputPayload unwraps _raw JSON object", () => {
  assert.deepEqual(
    normalizeToolInputPayload({ _raw: "{\"action\":\"read\",\"wing\":\"CONF_MODELS\"}" }),
    { action: "read", wing: "CONF_MODELS" },
  )
})

test("normalizeToolInputPayload unwraps fenced JSON object", () => {
  assert.deepEqual(
    normalizeToolInputPayload({ _raw: "```json\n{\"action\":\"read\",\"wing\":\"CONF_MODELS\"}\n```" }),
    { action: "read", wing: "CONF_MODELS" },
  )
})

test("normalizeToolInputPayload unwraps nested stringified JSON object", () => {
  assert.deepEqual(
    normalizeToolInputPayload({ _raw: "\"{\\\"action\\\":\\\"read\\\",\\\"wing\\\":\\\"CONF_MODELS\\\"}\"" }),
    { action: "read", wing: "CONF_MODELS" },
  )
})

test("normalizeToolInputPayload leaves non-object payloads unchanged", () => {
  assert.deepEqual(
    normalizeToolInputPayload({ _raw: "\"read\"" }),
    { _raw: "\"read\"" },
  )
})
