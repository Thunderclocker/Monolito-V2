import assert from "node:assert/strict"
import test from "node:test"
import { LOCAL_OLLAMA_MAX_TOOLS, selectToolsForLocalOllama } from "./localOllamaTools.ts"

const mockTools = Array.from({ length: 64 }, (_, i) => ({
  name: `Tool${i}`,
  description: "x".repeat(400),
  input_schema: { type: "object" as const, properties: {} },
}))

mockTools[0] = { name: "Web", description: "Search the web", input_schema: { type: "object", properties: { query: { type: "string" } } } }
mockTools[1] = { name: "Bash", description: "Run shell", input_schema: { type: "object", properties: { command: { type: "string" } } } }

test("selectToolsForLocalOllama caps tool count", () => {
  const selected = selectToolsForLocalOllama(mockTools as any, "hello", LOCAL_OLLAMA_MAX_TOOLS)
  assert.ok(selected.length <= LOCAL_OLLAMA_MAX_TOOLS)
})

test("selectToolsForLocalOllama boosts Web for weather queries", () => {
  const selected = selectToolsForLocalOllama(mockTools as any, "cual es el clima mañana", LOCAL_OLLAMA_MAX_TOOLS)
  assert.ok(selected.some(t => t.name === "Web"))
})

test("selectToolsForLocalOllama includes priority tools", () => {
  const selected = selectToolsForLocalOllama([{ name: "Bash", description: "a".repeat(500), input_schema: { type: "object", properties: {} } }], "hello", 8)
  assert.equal(selected[0]?.name, "Bash")
})
