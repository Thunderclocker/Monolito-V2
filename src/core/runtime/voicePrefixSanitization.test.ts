import { test } from "node:test"
import assert from "node:assert/strict"
import { sessionToMessages, finalize } from "./modelAdapter.ts"
import type { SessionRecord } from "../ipc/protocol.ts"

test("sessionToMessages: strips [voice] prefixes from assistant messages in history", () => {
  const session: SessionRecord = {
    id: "test-session",
    profileId: "default",
    title: "Test Session",
    state: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    voiceMode: true,
    worklog: [],
    messages: [
      {
        role: "user",
        text: "Hola",
        at: new Date().toISOString()
      },
      {
        role: "assistant",
        text: "[voice] [voice] [voice] Hola, ¿cómo estás?",
        at: new Date().toISOString()
      },
      {
        role: "user",
        text: "Qué tal",
        at: new Date().toISOString()
      },
      {
        role: "assistant",
        text: "voice: Todo bien, contando tips.",
        at: new Date().toISOString()
      }
    ]
  }

  const messages = sessionToMessages(session)

  assert.equal(messages.length, 4)
  assert.equal(messages[0].role, "user")
  assert.equal(messages[0].content, "Hola")
  
  assert.equal(messages[1].role, "assistant")
  assert.equal(messages[1].content, "Hola, ¿cómo estás?")

  assert.equal(messages[2].role, "user")
  assert.equal(messages[2].content, "Qué tal")

  assert.equal(messages[3].role, "assistant")
  assert.equal(messages[3].content, "Todo bien, contando tips.")
})

test("finalize: strips leading [voice] prefixes from turn.finalText", () => {
  const result1 = finalize("[voice] [voice] Hola!", [], Date.now(), 1)
  assert.equal(result1.finalText, "Hola!")

  const result2 = finalize("voice: Hola!", [], Date.now(), 1)
  assert.equal(result2.finalText, "Hola!")

  const result3 = finalize("[voice] voice: [voice] Hola!", [], Date.now(), 1)
  assert.equal(result3.finalText, "Hola!")

  const result4 = finalize("Esto contiene voice en el medio.", [], Date.now(), 1)
  assert.equal(result4.finalText, "Esto contiene voice en el medio.")
})
