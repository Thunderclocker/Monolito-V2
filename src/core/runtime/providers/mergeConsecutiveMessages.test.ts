import { test } from "node:test"
import assert from "node:assert/strict"
import { mergeConsecutiveMessages } from "./utils.ts"
import type { ConversationMessage } from "./types.ts"

test("mergeConsecutiveMessages: merges consecutive assistant messages", () => {
  const messages: ConversationMessage[] = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Got it, checking..." },
    { role: "assistant", content: "", toolCalls: [{ id: "call1", name: "Bash", input: { command: "ls" } }] }
  ]

  const merged = mergeConsecutiveMessages(messages)

  assert.equal(merged.length, 2)
  assert.equal(merged[0].role, "user")
  assert.equal(merged[0].content, "Hello")

  assert.equal(merged[1].role, "assistant")
  assert.equal(merged[1].content, "Got it, checking...")
  assert.ok("toolCalls" in merged[1])
  assert.equal(merged[1].toolCalls?.length, 1)
  assert.equal(merged[1].toolCalls?.[0].name, "Bash")
})

test("mergeConsecutiveMessages: merges consecutive user messages", () => {
  const messages: ConversationMessage[] = [
    { role: "user", content: "Hello" },
    { role: "user", content: "World" },
    { role: "assistant", content: "Hi" }
  ]

  const merged = mergeConsecutiveMessages(messages)

  assert.equal(merged.length, 2)
  assert.equal(merged[0].role, "user")
  assert.equal(merged[0].content, "Hello\n\nWorld")
  assert.equal(merged[1].role, "assistant")
  assert.equal(merged[1].content, "Hi")
})

test("mergeConsecutiveMessages: does NOT merge consecutive tool messages", () => {
  const messages: ConversationMessage[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "Bash", input: {} }, { id: "c2", name: "Read", input: {} }] },
    { role: "tool", toolCallId: "c1", toolName: "Bash", content: "output1" },
    { role: "tool", toolCallId: "c2", toolName: "Read", content: "output2" }
  ]

  const merged = mergeConsecutiveMessages(messages)

  assert.equal(merged.length, 3)
  assert.equal(merged[0].role, "assistant")
  assert.equal(merged[1].role, "tool")
  assert.equal(merged[1].toolCallId, "c1")
  assert.equal(merged[2].role, "tool")
  assert.equal(merged[2].toolCallId, "c2")
})
