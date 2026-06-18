import test from "node:test"
import assert from "node:assert/strict"
import { parseStructuredToolCalls } from "./types.ts"

test("parses Ollama-style object arguments (not a JSON string)", () => {
  const calls = parseStructuredToolCalls([
    { id: "call_1", function: { name: "Boot", arguments: { action: "write", file: "BOOT_USER", content: "Nombre: Cristian" } } },
  ])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.name, "Boot")
  assert.deepEqual(calls[0]!.input, { action: "write", file: "BOOT_USER", content: "Nombre: Cristian" })
})

test("parses OpenAI/Anthropic-style stringified arguments", () => {
  const calls = parseStructuredToolCalls([
    { id: "call_2", function: { name: "Web", arguments: JSON.stringify({ action: "search", query: "clima" }) } },
  ])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.input, { action: "search", query: "clima" })
})

test("synthesizes an id when the provider omits one", () => {
  const calls = parseStructuredToolCalls([
    { function: { name: "Boot", arguments: { action: "list" } } },
  ])
  assert.equal(calls.length, 1)
  assert.ok(calls[0]!.id.length > 0)
})

test("drops entries without a function name", () => {
  assert.equal(parseStructuredToolCalls([{ id: "x", function: {} }]).length, 0)
  assert.equal(parseStructuredToolCalls("nope").length, 0)
})
