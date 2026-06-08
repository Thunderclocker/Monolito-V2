// Tests para mcp-truncation.ts (Fase 11)

import test from "node:test"
import assert from "node:assert/strict"
import {
  truncateMcpResult,
  TRUNCATION_MARKER_PREFIX,
} from "./mcp-truncation.ts"

test("truncateMcpResult: small string passes through", () => {
  const r = truncateMcpResult("hello world", 1000)
  assert.equal(r.truncated, false)
  assert.equal(r.result, "hello world")
  assert.equal(r.removedChars, 0)
})

test("truncateMcpResult: large string is truncated", () => {
  const big = "x".repeat(100_000)
  const r = truncateMcpResult(big, 100) // budget 100 = 400 chars max
  assert.equal(r.truncated, true)
  assert.ok((r.result as string).includes(TRUNCATION_MARKER_PREFIX))
  assert.ok(r.removedChars > 0)
})

test("truncateMcpResult: small array passes through", () => {
  const arr = [1, 2, 3, 4, 5]
  const r = truncateMcpResult(arr, 100)
  assert.equal(r.truncated, false)
  assert.deepEqual(r.result, arr)
})

test("truncateMcpResult: large array is truncated", () => {
  const arr = Array.from({ length: 1000 }, (_, i) => ({ idx: i, payload: "x".repeat(100) }))
  const r = truncateMcpResult(arr, 50) // 200 chars
  assert.equal(r.truncated, true)
  assert.ok(Array.isArray(r.result))
  assert.ok((r.result as unknown[]).length < 1000)
  assert.ok(r.removedChars > 0)
})

test("truncateMcpResult: object passes through (not supported)", () => {
  const obj = { a: 1, b: 2 }
  const r = truncateMcpResult(obj, 100)
  assert.equal(r.truncated, false)
  assert.deepEqual(r.result, obj)
})

test("truncateMcpResult: null passes through", () => {
  const r = truncateMcpResult(null, 100)
  assert.equal(r.truncated, false)
  assert.equal(r.result, null)
})
