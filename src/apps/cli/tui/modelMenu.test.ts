import assert from "node:assert/strict"
import test from "node:test"
import { processMenuInput } from "./modelMenu.ts"
import {
  appendTranscriptBlocksAligned,
  scrollOffsetToRevealBlockStart,
} from "./renderer.ts"
import type { TranscriptBlock } from "./types.ts"

const mainState = { step: "main" as const, draft: {} }

test("processMenuInput: invalid main option re-shows full menu", async () => {
  const result = await processMenuInput("9", mainState)
  assert.match(result.output, /Options:/)
  assert.match(result.output, /1\. Select active model/)
  assert.match(result.output, /Invalid option "9"/)
  assert.equal(result.nextState?.step, "main")
})

test("processMenuInput: empty main input re-shows full menu", async () => {
  const result = await processMenuInput("", mainState)
  assert.match(result.output, /Options:/)
  assert.match(result.output, /Enter option number:/)
})

test("processMenuInput: /model refreshes menu instead of closing", async () => {
  const result = await processMenuInput("/model", mainState)
  assert.match(result.output, /Model Configuration/)
  assert.notEqual(result.nextState, null)
})

test("processMenuInput: exit closes menu", async () => {
  const result = await processMenuInput("exit", mainState)
  assert.equal(result.nextState, null)
})

test("scrollOffsetToRevealBlockStart: aligns long menu blocks to the top", () => {
  const shortBlock: TranscriptBlock = { type: "message", role: "user", text: "hi" }
  const longMenu: TranscriptBlock = {
    type: "event",
    label: "model",
    tone: "info",
    text: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"),
  }
  const blocks = [shortBlock, longMenu]
  const width = 80
  const visibleRows = 10
  const offset = scrollOffsetToRevealBlockStart(blocks, 1, width, visibleRows)
  const aligned = appendTranscriptBlocksAligned({ blocks: [shortBlock], scrollOffset: 0 }, [longMenu], width, visibleRows)
  assert.ok(offset > 0)
  assert.equal(aligned.scrollOffset, offset)
})
