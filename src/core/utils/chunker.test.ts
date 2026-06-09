// Tests para chunker.ts

import test from "node:test"
import assert from "node:assert/strict"
import {
  chunk,
  chunkByTokens,
  estimateTokens,
  headTailShrink,
  summarizeChunks,
  type Chunk,
} from "./chunker.ts"

test("estimateTokens: matches the 3.5 chars/token heuristic", () => {
  assert.equal(estimateTokens(""), 0)
  assert.equal(estimateTokens("x".repeat(3500)), 1000)
  assert.equal(estimateTokens("x".repeat(100)), Math.ceil(100 / 3.5))
  assert.equal(estimateTokens("x", 4), 1) // 1 char / 4 chars-per-token → ceil(0.25) = 1
})

test("chunk: short text returns a single chunk", () => {
  const chunks = chunk("hola mundo", { targetTokens: 100 })
  assert.equal(chunks.length, 1)
  const c = chunks[0] as Chunk
  assert.equal(c.text, "hola mundo")
  assert.equal(c.startOffset, 0)
  assert.equal(c.endOffset, 10)
  assert.equal(c.index, 0)
  assert.equal(c.isLast, true)
})

test("chunk: empty text returns a single empty chunk", () => {
  const chunks = chunk("", { targetTokens: 100 })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]?.text, "")
  assert.equal(chunks[0]?.isLast, true)
})

test("chunk: divides long text into multiple chunks within target size", () => {
  const text = "Lorem ipsum dolor sit amet. ".repeat(500) // ~13K chars
  const chunks = chunk(text, { targetTokens: 200, overlapTokens: 20 })
  assert.ok(chunks.length > 1, `expected > 1 chunk, got ${chunks.length}`)

  for (const c of chunks) {
    assert.ok(
      c.estimatedTokens <= 260,
      `chunk ${c.index} too big: ${c.estimatedTokens} tokens (target 200 + headroom)`,
    )
  }

  // Last chunk must be marked isLast=true.
  const last = chunks[chunks.length - 1] as Chunk
  assert.equal(last.isLast, true)
  // All others must be isLast=false.
  for (let i = 0; i < chunks.length - 1; i++) {
    assert.equal(chunks[i]?.isLast, false)
  }
})

test("chunk: respects sentence boundaries (no corta a media oración)", () => {
  // 100 sentences of the same length, target small so we get many chunks.
  const text = "Primera oracion completa. Segunda oracion completa. ".repeat(100)
  const chunks = chunk(text, { targetTokens: 50, overlapTokens: 10, boundaries: ["sentence"] })

  for (const c of chunks) {
    if (!c.isLast) {
      // Every non-last chunk should end with sentence-ending punctuation + whitespace.
      assert.match(
        c.text,
        /[.!?]\s*$/,
        `chunk ${c.index} does not end on a sentence boundary: ${JSON.stringify(c.text.slice(-30))}`,
      )
    }
  }
})

test("chunk: respects paragraph boundaries (\\n\\n) when configured", () => {
  const para = "Frase uno. Frase dos. Frase tres. "
  const text = (para + "\n\n").repeat(50) // ~50 paragraphs
  const chunks = chunk(text, { targetTokens: 200, overlapTokens: 0, boundaries: ["paragraph"] })
  assert.ok(chunks.length > 1)

  for (const c of chunks) {
    if (!c.isLast) {
      // Chunk end should be at or right after a paragraph break (\n\n).
      // Allow trailing whitespace, but should NOT cut mid-paragraph.
      const beforeText = text.slice(0, c.endOffset)
      assert.ok(
        beforeText.endsWith("\n\n") || /\.[\s ]*$/.test(c.text),
        `chunk ${c.index} does not end on a paragraph or sentence boundary`,
      )
    }
  }
})

test("chunk: overlap is applied (consecutive chunks share content)", () => {
  const text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(300)
  const chunks = chunk(text, { targetTokens: 100, overlapTokens: 30 })
  assert.ok(chunks.length > 1)

  // For each pair of consecutive chunks, the END of chunks[i] should overlap
  // with the START of chunks[i+1].
  for (let i = 0; i < chunks.length - 1; i++) {
    const a = chunks[i] as Chunk
    const b = chunks[i + 1] as Chunk
    // b.startOffset should be < a.endOffset (overlap region).
    assert.ok(
      b.startOffset < a.endOffset,
      `chunks ${i} and ${i + 1} do not overlap: a.end=${a.endOffset} b.start=${b.startOffset}`,
    )
    // The shared text region should be identical.
    const sharedA = text.slice(b.startOffset, a.endOffset)
    const sharedB = b.text.slice(0, a.endOffset - b.startOffset)
    assert.equal(sharedA, sharedB)
  }
})

test("chunk: stream mode returns AsyncIterable", async () => {
  const text = "x".repeat(10_000)
  const iterable = chunk(text, { targetTokens: 100, overlapTokens: 10, stream: true })
  // Must be AsyncIterable (has [Symbol.asyncIterator]).
  assert.equal(typeof (iterable as unknown as AsyncIterable<Chunk>)[Symbol.asyncIterator], "function")

  const collected: Chunk[] = []
  for await (const c of iterable as unknown as AsyncIterable<Chunk>) {
    collected.push(c)
  }
  assert.ok(collected.length > 1)
  assert.equal(collected[collected.length - 1]?.isLast, true)
})

test("chunkByTokens: greedy packing with overlap", () => {
  const tokens = Array.from({ length: 1000 }, (_, i) => `t${i}`)
  const chunks = chunkByTokens(tokens, {
    targetTokens: 100,
    overlapTokens: 10,
    detokenize: (t) => t.join(" "),
  })

  // 1000 / (100-10) = 11.11 → 12 chunks
  assert.equal(chunks.length, 12)
  // First chunk: tokens 0..99 → 100 tokens.
  assert.equal(chunks[0]?.estimatedTokens, 100)
  // Last chunk should be marked isLast.
  assert.equal(chunks[chunks.length - 1]?.isLast, true)
  // Middle chunk should be isLast=false.
  assert.equal(chunks[0]?.isLast, false)
})

test("chunkByTokens: throws on invalid overlap", () => {
  const tokens = ["a", "b", "c"]
  assert.throws(() => chunkByTokens(tokens, { targetTokens: 10, overlapTokens: 10, detokenize: (t) => t.join(" ") }))
  assert.throws(() => chunkByTokens(tokens, { targetTokens: 10, overlapTokens: 20, detokenize: (t) => t.join(" ") }))
  assert.throws(() => chunkByTokens(tokens, { targetTokens: 0, overlapTokens: 0, detokenize: (t) => t.join(" ") }))
})

test("summarizeChunks: aggregates stats correctly", () => {
  const chunks: Chunk[] = [
    { text: "a".repeat(350), startOffset: 0, endOffset: 350, index: 0, estimatedTokens: 100, isLast: false },
    { text: "b".repeat(700), startOffset: 350, endOffset: 1050, index: 1, estimatedTokens: 200, isLast: false },
    { text: "c".repeat(1400), startOffset: 1050, endOffset: 2450, index: 2, estimatedTokens: 400, isLast: true },
  ]
  const stats = summarizeChunks(chunks)
  assert.equal(stats.totalChunks, 3)
  assert.equal(stats.totalChars, 2450)
  assert.equal(stats.totalTokens, 700)
  assert.equal(stats.maxTokens, 400)
  assert.equal(stats.minTokens, 100)
  assert.equal(stats.avgTokensPerChunk, Math.round(700 / 3))
})

test("summarizeChunks: empty input returns zero stats", () => {
  const stats = summarizeChunks([])
  assert.equal(stats.totalChunks, 0)
  assert.equal(stats.totalChars, 0)
  assert.equal(stats.totalTokens, 0)
})

// -----------------------------------------------------------------------------
// headTailShrink — last-resort shrink used by the embedding overflow
// recovery chain in session/embeddings.ts. Regression test for the
// 2026-06-09 incident where 8 consecutive embedding calls returned HTTP
// 500 "input length exceeds" and the runtime degraded to zero-vectors.
// -----------------------------------------------------------------------------

test("headTailShrink: returns null for empty input", () => {
  assert.equal(headTailShrink("", 0.4), null)
  assert.equal(headTailShrink("a", 0.4), null)
})

test("headTailShrink: keeps the requested fraction of head and tail", () => {
  const text = "A".repeat(200) + "B".repeat(200) + "C".repeat(200) + "D".repeat(200)
  const shrunk = headTailShrink(text, 0.4)
  assert.ok(shrunk)
  // 40% of 800 = 320 chars total = 160 head + 160 tail
  assert.ok(shrunk.startsWith("A".repeat(160)))
  assert.ok(shrunk.endsWith("D".repeat(160)))
  // Contains the marker
  assert.match(shrunk, /\[\.\.\.shrunk for embedding recovery\.\.\.\]/)
  // Drops the middle
  assert.ok(!shrunk.includes("B".repeat(100)))
  assert.ok(!shrunk.includes("C".repeat(100)))
})

test("headTailShrink: clamps fraction to safe bounds", () => {
  const text = "X".repeat(1000)
  // 0 (too small) is clamped to 0.05
  const r1 = headTailShrink(text, 0)
  assert.ok(r1)
  // > 0.5 is clamped to 0.5
  const r2 = headTailShrink(text, 0.99)
  assert.ok(r2)
  assert.ok(r2.length < text.length)
})
