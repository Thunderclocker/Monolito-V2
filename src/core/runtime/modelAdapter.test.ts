import test from "node:test"
import assert from "node:assert/strict"
import { MODEL_ADAPTER_TESTING } from "./modelAdapter.ts"

test("model adapter treats structured web evidence as sufficient", () => {
  const records = [{
    id: "1",
    tool: "WebFetch",
    input: {
      url: "https://api.open-meteo.com/v1/forecast?latitude=-34.61&longitude=-58.44&daily=temperature_2m_max",
      prompt: "forecast",
    },
    output: {
      url: "https://api.open-meteo.com/v1/forecast?latitude=-34.61&longitude=-58.44&daily=temperature_2m_max",
      code: 200,
      result: "{\"daily\":{\"time\":[\"2026-04-21\"],\"temperature_2m_max\":[21.8]}}",
    },
  }]

  assert.equal(MODEL_ADAPTER_TESTING.hasStructuredEvidenceHit(records), true)
  assert.equal(MODEL_ADAPTER_TESTING.shouldNudgeTowardSynthesis(records), true)
})

test("model adapter rejects redundant follow-up probes for the same source family after sufficient evidence", () => {
  const existingRecords = [
    {
      id: "1",
      tool: "WebFetch",
      input: {
        url: "https://wttr.in/Buenos+Aires?lang=es&m&1",
        prompt: "forecast",
      },
      output: {
        url: "https://wttr.in/Buenos+Aires?lang=es&m&1",
        code: 200,
        result: "Buenos Aires: Soleado 24C",
      },
    },
    {
      id: "2",
      tool: "WebFetch",
      input: {
        url: "https://api.open-meteo.com/v1/forecast?latitude=-34.61&longitude=-58.44&daily=temperature_2m_max",
        prompt: "forecast",
      },
      output: {
        url: "https://api.open-meteo.com/v1/forecast?latitude=-34.61&longitude=-58.44&daily=temperature_2m_max",
        code: 200,
        result: "{\"daily\":{\"time\":[\"2026-04-21\"],\"temperature_2m_max\":[21.8]}}",
      },
    },
  ]

  const nextUses = [{
    id: "3",
    tool: "WebFetch",
    input: {
      url: "https://api.open-meteo.com/v1/forecast?latitude=-34.61&longitude=-58.44&daily=temperature_2m_max",
      prompt: "forecast",
    },
  }]

  assert.equal(MODEL_ADAPTER_TESTING.shouldRejectRedundantFollowUpToolUses(existingRecords, nextUses), true)
})

test("model adapter excludes task notifications from normal history messages", () => {
  const session = {
    id: "telegram-1",
    title: "Test",
    profileId: "default",
    state: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      { role: "user", text: "hola", at: new Date().toISOString() },
      { role: "user", text: "<task-notification>\n<status>completed</status>\n<summary>done</summary>\n<result>x</result>\n</task-notification>", at: new Date().toISOString() },
      { role: "assistant", text: "ok", at: new Date().toISOString() },
    ],
    worklog: [],
  }

  const messages = MODEL_ADAPTER_TESTING.sessionToAnthropicMessages(session as any)
  assert.equal(messages.some(message => typeof message.content === "string" && message.content.includes("<task-notification>")), false)
})
