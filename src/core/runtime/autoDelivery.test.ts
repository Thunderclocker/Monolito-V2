// Tests for findUndeliveredToolOutputs. The fix is for the 2026-06-09
// 23:47 incident where GenerateSpeech produced a 419949-byte audio
// file and the model emitted the `<gen_audio>` metadata tag, but
// never called TelegramSendVoice — the audio never reached the user.
// The runtime now auto-injects the matching delivery tool call.

import test from "node:test"
import assert from "node:assert/strict"
import { findUndeliveredToolOutputs } from "./autoDelivery.ts"

function evidence(toolName: string, fields: Record<string, unknown>) {
  // Mimic formatToolEvidenceResult output: <tool-evidence ...> {JSON} </tool-evidence>
  return `<tool-evidence tool="${toolName}" status="success">\n${JSON.stringify(fields)}\n</tool-evidence>`
}

test("findUndeliveredToolOutputs: empty messages returns empty", () => {
  assert.deepEqual(findUndeliveredToolOutputs([]), [])
})

test("findUndeliveredToolOutputs: returns empty when no generation tool ran", () => {
  const messages = [
    { role: "tool", toolName: "Bash", content: evidence("Bash", { stdout: "ok" }) },
  ]
  assert.deepEqual(findUndeliveredToolOutputs(messages), [])
})

test("findUndeliveredToolOutputs: flags GenerateSpeech without TelegramSendVoice", () => {
  const audioPath = "/home/cristian/.monolito/workspace/scratchpad/tts/amanda_voz-abc.mp3"
  const messages = [
    { role: "tool", toolName: "GenerateSpeech", content: evidence("GenerateSpeech", {
      local_path: audioPath,
      bytes: 419949,
      response_format: "mp3",
    }) },
  ]
  const result = findUndeliveredToolOutputs(messages)
  assert.equal(result.length, 1)
  assert.equal(result[0].sourceTool, "GenerateSpeech")
  assert.equal(result[0].localPath, audioPath)
  // response_format is mp3 → TelegramSendAudio
  assert.equal(result[0].deliveryTool, "TelegramSendAudio")
  assert.deepEqual(result[0].deliveryInput, { audio: audioPath })
})

test("findUndeliveredToolOutputs: ogg/opus response_format maps to TelegramSendVoice", () => {
  const audioPath = "/tmp/voice.ogg"
  const messages = [
    { role: "tool", toolName: "GenerateSpeech", content: evidence("GenerateSpeech", {
      local_path: audioPath,
      response_format: "ogg",
    }) },
  ]
  const result = findUndeliveredToolOutputs(messages)
  assert.equal(result.length, 1)
  assert.equal(result[0].deliveryTool, "TelegramSendVoice")
  assert.deepEqual(result[0].deliveryInput, { voice: audioPath })
})

test("findUndeliveredToolOutputs: opus format also maps to voice", () => {
  const messages = [
    { role: "tool", toolName: "GenerateSpeech", content: evidence("GenerateSpeech", {
      local_path: "/tmp/voice.opus",
      response_format: "opus",
    }) },
  ]
  const result = findUndeliveredToolOutputs(messages)
  assert.equal(result[0].deliveryTool, "TelegramSendVoice")
})

test("findUndeliveredToolOutputs: missing response_format defaults to voice (legacy)", () => {
  const messages = [
    { role: "tool", toolName: "GenerateSpeech", content: evidence("GenerateSpeech", {
      local_path: "/tmp/voice.ogg",
    }) },
  ]
  const result = findUndeliveredToolOutputs(messages)
  assert.equal(result[0].deliveryTool, "TelegramSendVoice")
})

test("findUndeliveredToolOutputs: GenerateImage without TelegramSendPhoto", () => {
  const imagePath = "/tmp/img.png"
  const messages = [
    { role: "tool", toolName: "GenerateImage", content: evidence("GenerateImage", {
      local_path: imagePath,
    }) },
  ]
  const result = findUndeliveredToolOutputs(messages)
  assert.equal(result.length, 1)
  assert.equal(result[0].sourceTool, "GenerateImage")
  assert.equal(result[0].deliveryTool, "TelegramSendPhoto")
  assert.deepEqual(result[0].deliveryInput, { photo: imagePath })
})

test("findUndeliveredToolOutputs: skips when model already called TelegramSendVoice with same path", () => {
  const audioPath = "/tmp/voice.ogg"
  const messages = [
    { role: "tool", toolName: "GenerateSpeech", content: evidence("GenerateSpeech", {
      local_path: audioPath,
    }) },
    {
      role: "assistant",
      toolCalls: [
        { name: "TelegramSendVoice", input: { voice: audioPath, chat_id: 12345 } },
      ],
    },
    { role: "tool", toolName: "TelegramSendVoice", content: evidence("TelegramSendVoice", { ok: true, message_id: 21213 }) },
  ]
  const result = findUndeliveredToolOutputs(messages)
  assert.equal(result.length, 0, "Model already delivered — should NOT inject a duplicate")
})

test("findUndeliveredToolOutputs: flags a SECOND generated audio that was not delivered", () => {
  const firstPath = "/tmp/voice1.ogg"
  const secondPath = "/tmp/voice2.ogg"
  const messages = [
    { role: "tool", toolName: "GenerateSpeech", content: evidence("GenerateSpeech", { local_path: firstPath }) },
    {
      role: "assistant",
      toolCalls: [
        { name: "TelegramSendVoice", input: { voice: firstPath, chat_id: 12345 } },
      ],
    },
    { role: "tool", toolName: "TelegramSendVoice", content: evidence("TelegramSendVoice", { ok: true, message_id: 21213 }) },
    { role: "tool", toolName: "GenerateSpeech", content: evidence("GenerateSpeech", { local_path: secondPath }) },
  ]
  const result = findUndeliveredToolOutputs(messages)
  // The first audio was explicitly delivered (TelegramSendVoice tool
  // call with the first local_path). The second one was not.
  assert.equal(result.length, 1)
  assert.equal(result[0].localPath, secondPath)
})

test("findUndeliveredToolOutputs: tolerates a content string without tool-evidence wrapper", () => {
  const audioPath = "/tmp/voice.ogg"
  const messages = [
    { role: "tool", toolName: "GenerateSpeech", content: JSON.stringify({ local_path: audioPath }) },
  ]
  const result = findUndeliveredToolOutputs(messages)
  assert.equal(result.length, 1)
  assert.equal(result[0].localPath, audioPath)
})
