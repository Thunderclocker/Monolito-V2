import { test } from "node:test"
import assert from "node:assert/strict"
import type { ResearchCheckpointFile } from "../session/store.ts"
import {
  filterSourceKeysForTurn,
  formatAbortedResearchUserMessage,
  formatResearchCheckpointPromptBlock,
  hasResearchToolSteps,
  isResearchContinuationRequest,
  shouldInjectResearchCheckpoint,
  sharesTopicWithCheckpoint,
} from "./researchCheckpoint.ts"

const sampleCheckpoint: ResearchCheckpointFile = {
  createdAt: new Date().toISOString(),
  userRequest: "investiga la relacion de duran duran invisible con metal gear",
  reason: "turn_aborted",
  turnStartedAt: new Date(Date.now() - 120_000).toISOString(),
  toolsRun: ["WebSearch", "WebFetch"],
  sourceKeys: ["WebSearch:1000", "WebFetch:2000"],
  evidenceIndex: [
    { tool: "WebSearch", summary: "WebSearch: INVISIBLE Duran Duran Metal Gear" },
    { tool: "WebFetch", summary: "WebFetch: https://example.com/article", url: "https://example.com/article" },
  ],
  tasksCompleted: 3,
  consumed: false,
}

test("hasResearchToolSteps detects WebSearch/WebFetch", () => {
  assert.equal(hasResearchToolSteps([{ type: "tool", tool: "TodoWrite", input: {} }]), false)
  assert.equal(hasResearchToolSteps([{ type: "tool", tool: "WebSearch", input: { query: "x" } }]), true)
})

test("filterSourceKeysForTurn keeps keys from the active turn window", () => {
  const turnStarted = 1_000_000
  const keys = filterSourceKeysForTurn(
    [
      { key: "WebSearch:990000", content: "old" },
      { key: "WebFetch:1000500", content: "new" },
    ],
    turnStarted,
  )
  assert.deepEqual(keys, ["WebFetch:1000500"])
})

test("isResearchContinuationRequest matches retry phrases", () => {
  assert.equal(isResearchContinuationRequest("seguí con lo que buscaste"), true)
  assert.equal(isResearchContinuationRequest("reintentá"), true)
  assert.equal(isResearchContinuationRequest("che y el clima mañana?"), false)
})

test("sharesTopicWithCheckpoint requires meaningful overlap", () => {
  assert.equal(sharesTopicWithCheckpoint("investiga duran duran metal gear otra vez", sampleCheckpoint), true)
  assert.equal(sharesTopicWithCheckpoint("predecime el clima en buenos aires", sampleCheckpoint), false)
})

test("shouldInjectResearchCheckpoint on explicit continuation", () => {
  assert.equal(shouldInjectResearchCheckpoint("reintentá", sampleCheckpoint), true)
})

test("shouldInjectResearchCheckpoint rejects consumed checkpoint", () => {
  assert.equal(shouldInjectResearchCheckpoint("reintentá", { ...sampleCheckpoint, consumed: true }), false)
})

test("formatResearchCheckpointPromptBlock includes excerpts with budget", () => {
  const block = formatResearchCheckpointPromptBlock(sampleCheckpoint, [
    { key: "WebSearch:1000", content: "Resultados de búsqueda ".repeat(200) },
  ], 500)
  assert.match(block, /<research_checkpoint>/)
  assert.match(block, /WebSearch:1000/)
  assert.ok(block.length < 2_000)
})

test("formatAbortedResearchUserMessage mentions saved evidence", () => {
  const msg = formatAbortedResearchUserMessage(sampleCheckpoint)
  assert.match(msg, /evidencia quedó guardada/i)
  assert.match(msg, /reintentá/i)
})
