import test from "node:test"
import assert from "node:assert/strict"

// Definición local del tipo ConversationMessage simplificado para testear
interface MockMessage {
  role: "user" | "assistant" | "tool"
  toolCalls?: Array<{ name: string; input: Record<string, any> }>
}

function isToolCallStalled(
  messages: MockMessage[],
  toolName: string,
  toolInput: Record<string, unknown>
): { stalled: boolean; count: number } {
  const targetArgs = JSON.stringify(toolInput)
  let count = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") {
      break // Reseteo de contexto en cada frontera de mensaje del usuario real
    }
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        if (tc.name === toolName && JSON.stringify(tc.input) === targetArgs) {
          count++
        }
      }
    }
  }

  return { stalled: count >= 3, count }
}

test("isToolCallStalled detects stalling correctly on 3rd call", () => {
  const messages: MockMessage[] = [
    { role: "user" },
    { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run test" } }] },
    { role: "tool" },
    { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run test" } }] },
    { role: "tool" },
    { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run test" } }] }, // 3ra vez
  ]

  const result = isToolCallStalled(messages, "Bash", { command: "npm run test" })
  assert.equal(result.stalled, true)
  assert.equal(result.count, 3)
})

test("isToolCallStalled does not report stalling on 2nd call", () => {
  const messages: MockMessage[] = [
    { role: "user" },
    { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run test" } }] },
    { role: "tool" },
    { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run test" } }] },
  ]

  const result = isToolCallStalled(messages, "Bash", { command: "npm run test" })
  assert.equal(result.stalled, false)
  assert.equal(result.count, 2)
})

test("isToolCallStalled resets on new user turn", () => {
  const messages: MockMessage[] = [
    { role: "user" },
    { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run test" } }] },
    { role: "tool" },
    { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run test" } }] },
    { role: "tool" },
    { role: "user" }, // Nuevo turno de usuario!
    { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run test" } }] },
  ]

  const result = isToolCallStalled(messages, "Bash", { command: "npm run test" })
  assert.equal(result.stalled, false)
  assert.equal(result.count, 1)
})

test("isToolCallStalled differentiates tools and arguments", () => {
  const messages: MockMessage[] = [
    { role: "user" },
    { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run test" } }] },
    { role: "tool" },
    { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run lint" } }] },
    { role: "tool" },
    { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run test" } }] },
  ]

  const result = isToolCallStalled(messages, "Bash", { command: "npm run test" })
  assert.equal(result.stalled, false)
  assert.equal(result.count, 2)
})
