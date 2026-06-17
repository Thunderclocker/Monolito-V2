import assert from "node:assert/strict"
import test from "node:test"
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages"
import { ensureToolResultPairing, SYNTHETIC_TOOL_RESULT_PLACEHOLDER } from "./ensureToolResultPairing.ts"

test("ensureToolResultPairing: inserts synthetic tool_result for missing result", () => {
  const messages: MessageParam[] = [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "WebSearch", input: { query: "weather" } }],
    },
  ]
  const repaired = ensureToolResultPairing(messages)
  assert.equal(repaired.length, 2)
  assert.equal(repaired[1].role, "user")
  const userContent = repaired[1].content
  assert.ok(Array.isArray(userContent))
  assert.equal(userContent[0]?.type, "tool_result")
  if (userContent[0]?.type === "tool_result") {
    assert.equal(userContent[0].tool_use_id, "tu_1")
    assert.equal(userContent[0].content, SYNTHETIC_TOOL_RESULT_PLACEHOLDER)
  }
})

test("ensureToolResultPairing: strips duplicate tool_use ids across assistants", () => {
  const messages: MessageParam[] = [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_dup", name: "Bash", input: {} }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_dup", content: "ok" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_dup", name: "Read", input: {} }],
    },
  ]
  const repaired = ensureToolResultPairing(messages)
  const assistants = repaired.filter(m => m.role === "assistant")
  const toolUses = assistants.flatMap(m =>
    Array.isArray(m.content) ? m.content.filter(b => "type" in b && b.type === "tool_use") : [],
  )
  assert.equal(toolUses.length, 1)
})

test("ensureToolResultPairing: leaves valid pairs unchanged", () => {
  const messages: MessageParam[] = [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_ok", name: "Read", input: { path: "/tmp/x" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_ok", content: "file contents" }] },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
  ]
  assert.deepEqual(ensureToolResultPairing(messages), messages)
})
