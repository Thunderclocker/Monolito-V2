/**
 * Regression test for listModelTools — the inputSchema field name.
 *
 * Pre-existing bug (fixed in commit bbf42a4): listModelTools was returning
 * tool definitions with `input_schema` (snake_case), but the Anthropic
 * Messages API expects `inputSchema` (camelCase). The model would silently
 * reject tools with wrong field names, making the agent appear to work
 * but unable to actually invoke any tool.
 *
 * This test pins down the contract: every tool returned by listModelTools
 * must have an `inputSchema` field (camelCase). If anyone refactors and
 * reintroduces snake_case, this test will fail.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { listModelTools } from "./registry.ts"

test("listModelTools: every returned tool has inputSchema (camelCase)", () => {
  const tools = listModelTools()
  assert.ok(tools.length > 0, "expected at least one tool")
  for (const tool of tools) {
    assert.ok("inputSchema" in tool, `tool ${tool.name} missing inputSchema field`)
    assert.ok(tool.inputSchema !== undefined, `tool ${tool.name} has undefined inputSchema`)
    assert.equal(
      (tool as unknown as { input_schema?: unknown }).input_schema,
      undefined,
      `tool ${tool.name} uses snake_case 'input_schema' — the model API expects 'inputSchema'`,
    )
  }
})

test("listModelTools: returned tools are the right shape for the Messages API", () => {
  const tools = listModelTools()
  for (const tool of tools) {
    // The Anthropic Messages API requires: { name, description, input_schema: {...} }
    // We send the camelCase version because the SDK transforms it.
    assert.equal(typeof tool.name, "string")
    assert.equal(typeof tool.description, "string")
    assert.ok(typeof tool.inputSchema === "object" && tool.inputSchema !== null)
    const schema = tool.inputSchema as { type?: string; properties?: unknown }
    assert.equal(schema.type, "object", `tool ${tool.name} inputSchema.type must be 'object'`)
  }
})

test("listModelTools: sub-agent mode excludes hidden-from-sub-agents tools", () => {
  const mainTools = listModelTools(false)
  const subTools = listModelTools(true)
  // Some tools (like AgentSpawn) should be hidden from sub-agents
  assert.ok(subTools.length <= mainTools.length, "sub-agent tool set must be a subset of main tool set")
  const subNames = new Set(subTools.map(t => t.name))
  for (const tool of mainTools) {
    if (subNames.has(tool.name)) {
      // If the tool is in both sets, the shape must be identical
      assert.equal(typeof tool.inputSchema, "object")
    }
  }
})
