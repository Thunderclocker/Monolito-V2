import assert from "node:assert/strict"
import test from "node:test"
import { appendTranscriptBlocks, findInFlightToolEventIndex } from "./renderer.ts"
import type { TranscriptBlock } from "./types.ts"

const empty = { blocks: [] as TranscriptBlock[], scrollOffset: 0 }

test("appendTranscriptBlocks merges tool.finish into matching tool.start by toolUseId", () => {
  const start: TranscriptBlock = {
    type: "event",
    label: "",
    tone: "info",
    text: "Reading tts.defaultClonedVoice...",
    tool: "tool_manage_config",
    toolUseId: "call-1",
  }
  const finish: TranscriptBlock = {
    type: "event",
    label: "",
    tone: "success",
    text: "Updated tts.defaultClonedVoice · 269 bytes",
    tool: "tool_manage_config",
    toolUseId: "call-1",
    replacesLastEvent: true,
  }

  const afterStart = appendTranscriptBlocks(empty, [start])
  assert.equal(afterStart.blocks.length, 1)
  assert.equal((afterStart.blocks[0] as Extract<TranscriptBlock, { type: "event" }>).tone, "info")

  const afterFinish = appendTranscriptBlocks(afterStart, [finish])
  assert.equal(afterFinish.blocks.length, 1)
  const row = afterFinish.blocks[0] as Extract<TranscriptBlock, { type: "event" }>
  assert.equal(row.tone, "success")
  assert.match(row.text, /Updated tts\.defaultClonedVoice/)
})

test("appendTranscriptBlocks merges tool.finish into last in-flight tool by name when toolUseId missing", () => {
  const start: TranscriptBlock = {
    type: "event",
    label: "",
    tone: "info",
    text: "Generating speech...",
    tool: "GenerateSpeech",
  }
  const finish: TranscriptBlock = {
    type: "event",
    label: "",
    tone: "success",
    text: "Speech generated (652653 bytes)",
    tool: "GenerateSpeech",
    replacesLastEvent: true,
  }

  const merged = appendTranscriptBlocks(appendTranscriptBlocks(empty, [start]), [finish])
  assert.equal(merged.blocks.length, 1)
  const row = merged.blocks[0] as Extract<TranscriptBlock, { type: "event" }>
  assert.equal(row.tone, "success")
  assert.match(row.text, /Speech generated/)
})

test("findInFlightToolEventIndex prefers info-tone running row for same tool", () => {
  const blocks: TranscriptBlock[] = [
    { type: "event", label: "", tone: "success", text: "Done earlier", tool: "Read" },
    { type: "event", label: "", tone: "info", text: "Generating speech...", tool: "GenerateSpeech" },
  ]
  const finish: TranscriptBlock = {
    type: "event",
    label: "",
    tone: "success",
    text: "Speech generated (100 bytes)",
    tool: "GenerateSpeech",
    replacesLastEvent: true,
  }
  assert.equal(findInFlightToolEventIndex(blocks, finish), 1)
})
