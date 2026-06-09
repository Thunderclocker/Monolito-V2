// Tests for the embedding pipeline's truncation behavior.
//
// Bug #1 (09-jun-2026): MAX_OLLAMA_EMBED_CHARS = 24_000 caused HTTP 500
// "input length exceeds the context length" from bge-m3 because Spanish/code
// tokenize denser than the English heuristic. Fix: cap by tokens instead of
// chars via estimateTokens().

import { test } from "node:test"
import assert from "node:assert/strict"
import { estimateTokens } from "../utils/chunker.ts"
import { MAX_OLLAMA_EMBED_TOKENS, truncateForEmbedding } from "./embeddings.ts"

test("truncateForEmbedding: short text passes through unchanged", () => {
  const short = "Hello world. This is a short text for embedding."
  assert.equal(truncateForEmbedding(short), short)
})

test("truncateForEmbedding: medium text (under 6000 tokens) is unchanged", () => {
  // ~1000 tokens at 3.5 chars/token
  const medium = "a".repeat(3500)
  assert.equal(truncateForEmbedding(medium), medium)
  assert.ok(estimateTokens(medium) <= MAX_OLLAMA_EMBED_TOKENS)
})

test("truncateForEmbedding: long text (~30K chars) gets truncated to fit 6000 tokens", () => {
  // ~8570 tokens at 3.5 chars/token — must trigger truncation
  const long = "x".repeat(30_000)
  const truncated = truncateForEmbedding(long)
  assert.ok(truncated.length < long.length, "long text should be truncated")
  assert.ok(
    estimateTokens(truncated) <= MAX_OLLAMA_EMBED_TOKENS + 50, // 50-token fuzz for the marker text
    `truncated should be <= ${MAX_OLLAMA_EMBED_TOKENS} tokens, got ${estimateTokens(truncated)}`
  )
})

test("truncateForEmbedding: keeps head and tail, drops deep middle", () => {
  // The truncation keeps first ~10468 chars and last ~10468 chars. Place the
  // unique marker DEEP in the filler (after char 20000) so it falls in the
  // dropped middle.
  const head = "h".repeat(20_000) // ensure the marker is in the dropped region
  const deepMarker = "DEEP_MIDDLE_MARKER_xyz123"
  const tail = "t".repeat(20_000)
  const long = head + deepMarker + tail
  const truncated = truncateForEmbedding(long)
  assert.ok(truncated.includes("[...truncated for embedding context budget...]"), "should have truncation marker")
  assert.ok(!truncated.includes(deepMarker), `should drop deep middle marker; got ${truncated.length} chars`)
  // head and tail fragments should be present (the function slices ~half from each end)
  assert.ok(/^h+/.test(truncated.split("[...truncated")[0]!), "head run of h's should survive")
  assert.ok(/t+$/.test(truncated.split("[...truncated")[1]!), "tail run of t's should survive")
})

test("truncateForEmbedding: the previous char cap (24_000) WOULD have overflowed bge-m3", () => {
  // Demonstrates the regression: 30_000 chars of dense Spanish → > 6000 tokens
  // → was overflowing bge-m3's 8192-token context (with special tokens on top).
  const dense = "áéíóúñ".repeat(6000) // 30_000 chars
  assert.ok(estimateTokens(dense) > 6000, "regression: 30K chars of accented Spanish is > 6000 tokens")
  // New code path truncates; old code path would have let it through.
  const truncated = truncateForEmbedding(dense)
  assert.ok(estimateTokens(truncated) <= MAX_OLLAMA_EMBED_TOKENS + 50)
})

test("truncateForEmbedding: empty string is a no-op", () => {
  assert.equal(truncateForEmbedding(""), "")
})

test("truncateForEmbedding: whitespace-only string is a no-op", () => {
  assert.equal(truncateForEmbedding("   \n\n  \t  "), "   \n\n  \t  ")
})

test("MAX_OLLAMA_EMBED_TOKENS leaves headroom for bge-m3's 8192-token context", () => {
  // Sanity check: our cap must be below the model's hard limit. 2K headroom
  // for special tokens / tokenizer variance / bge-m3's own prefix tokens.
  assert.ok(MAX_OLLAMA_EMBED_TOKENS < 8192, "cap must be below bge-m3 num_ctx")
  assert.ok(8192 - MAX_OLLAMA_EMBED_TOKENS >= 1000, "must have meaningful headroom")
})
