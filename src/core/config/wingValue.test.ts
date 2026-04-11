import test from "node:test"
import assert from "node:assert/strict"
import { coerceConfigRecord } from "./wingValue.ts"

test("coerceConfigRecord keeps plain objects", () => {
  assert.deepEqual(coerceConfigRecord({ a: 1 }), { a: 1 })
})

test("coerceConfigRecord parses stringified objects", () => {
  assert.deepEqual(
    coerceConfigRecord("{\"version\":1,\"profiles\":[]}"),
    { version: 1, profiles: [] },
  )
})

test("coerceConfigRecord parses nested stringified objects", () => {
  assert.deepEqual(
    coerceConfigRecord("\"{\\\"version\\\":1,\\\"profiles\\\":[]}\""),
    { version: 1, profiles: [] },
  )
})
