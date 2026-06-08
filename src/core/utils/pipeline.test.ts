// Tests para pipeline.ts

import test from "node:test"
import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { bindCursorDb, _resetSchemaCacheForTests } from "./cursor.ts"
import { processStream } from "./pipeline.ts"
import { type Chunk } from "./chunker.ts"

function freshDb(): Database.Database {
  _resetSchemaCacheForTests()
  const db = new Database(":memory:")
  bindCursorDb(db)
  return db
}

function fakeChunk(index: number, text = `chunk-${index}`, isLast = false): Chunk {
  return {
    text,
    startOffset: index * 10,
    endOffset: index * 10 + text.length,
    index,
    estimatedTokens: 1,
    isLast,
  }
}

test("pipeline: processes all chunks in a stream", async () => {
  const db = freshDb()
  const events: number[] = []
  const source = Array.from({ length: 5 }, (_, i) => fakeChunk(i, `c${i}`, i === 4))
  const result = await processStream(db, {
    streamId: "t:1",
    source,
    processor: async (c) => `out:${c.text}`,
    sink: async (out, c) => { events.push(c.index) },
  })
  assert.equal(result.totalProcessed, 5)
  assert.equal(result.totalErrors, 0)
  assert.equal(result.done, true)
  assert.deepEqual(events, [0, 1, 2, 3, 4])
})

test("pipeline: resumes from cursor after partial run (maxChunks=3)", async () => {
  const db = freshDb()
  const events: number[] = []
  const source = Array.from({ length: 10 }, (_, i) => fakeChunk(i, `c${i}`, i === 9))

  // First pass: process 3 chunks only.
  const r1 = await processStream(db, {
    streamId: "t:resume",
    source,
    processor: async (c) => `out:${c.text}`,
    sink: async (out, c) => { events.push(c.index) },
    maxChunks: 3,
  })
  assert.equal(r1.totalProcessed, 3)
  assert.equal(r1.done, false)
  assert.deepEqual(events, [0, 1, 2])

  // Second pass: resume from cursor.
  const r2 = await processStream(db, {
    streamId: "t:resume",
    source,
    processor: async (c) => `out:${c.text}`,
    sink: async (out, c) => { events.push(c.index) },
  })
  assert.equal(r2.totalProcessed, 7)
  assert.deepEqual(events, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test("pipeline: chunk errors don't break the stream, are counted", async () => {
  const db = freshDb()
  const events: number[] = []
  const source = ["a", "b", "c", "d"].map((c, i) => fakeChunk(i, c, i === 3))
  const result = await processStream(db, {
    streamId: "t:err",
    source,
    processor: async (c) => {
      if (c.text === "b") throw new Error("intentional")
      return c.text
    },
    sink: async (out, c) => { events.push(c.index) },
  })
  assert.equal(result.totalProcessed, 3)
  assert.equal(result.totalErrors, 1)
  assert.deepEqual(events, [0, 2, 3]) // "b" failed, cursor still advanced past it
})

test("pipeline: processor returning null skips silently (no error counted)", async () => {
  const db = freshDb()
  const events: number[] = []
  const source = Array.from({ length: 3 }, (_, i) => fakeChunk(i, `c${i}`, i === 2))
  const result = await processStream(db, {
    streamId: "t:null",
    source,
    processor: async (c) => (c.index === 1 ? null : c.text),
    sink: async (out, c) => { events.push(c.index) },
  })
  assert.equal(result.totalProcessed, 2)
  assert.equal(result.totalErrors, 0)
  assert.deepEqual(events, [0, 2])
})

test("pipeline: AbortSignal cancels the stream", async () => {
  const db = freshDb()
  const events: number[] = []
  const controller = new AbortController()
  const source = Array.from({ length: 100 }, (_, i) => fakeChunk(i, `c${i}`, i === 99))

  // Schedule abort after a short delay.
  setTimeout(() => controller.abort(), 5)

  // The processor must respect the abort signal — otherwise 100 sync chunks
  // finish before abort takes effect. Simulate per-chunk I/O with a microtask.
  const result = await processStream(db, {
    streamId: "t:abort",
    source,
    processor: async (c) => {
      await new Promise((r) => setTimeout(r, 1)) // 1ms I/O sim
      if (controller.signal.aborted) throw new Error("aborted")
      return c.text
    },
    sink: async (out, c) => { events.push(c.index) },
    abortSignal: controller.signal,
  })

  // We can't predict exactly how many chunks ran before abort, but it should
  // be < 100 and >= 0. With abort, done=false (stream was interrupted).
  assert.ok(result.totalProcessed < 100, `expected < 100, got ${result.totalProcessed}`)
  assert.equal(result.done, false, "done must be false when stream was aborted")
})

test("pipeline: string source is chunked automatically", async () => {
  const db = freshDb()
  const events: number[] = []
  const text = "Hola mundo. ".repeat(1000) // ~13K chars
  const result = await processStream(db, {
    streamId: "t:string",
    source: text,
    chunker: { targetTokens: 200, overlapTokens: 20 },
    processor: async (c) => c.text,
    sink: async (out, c) => { events.push(c.index) },
  })
  assert.ok(result.totalProcessed > 1, `expected > 1, got ${result.totalProcessed}`)
  assert.equal(result.totalErrors, 0)
})

test("pipeline: reset option clears cursor and re-processes from 0", async () => {
  const db = freshDb()
  const events: number[] = []
  const source = ["x", "y", "z"].map((t, i) => fakeChunk(i, t, i === 2))

  // First pass: process all 3.
  await processStream(db, {
    streamId: "t:reset",
    source,
    processor: async (c) => c.text,
    sink: async (out, c) => { events.push(c.index) },
  })
  assert.equal(events.length, 3)

  // Reset and re-process.
  const r2 = await processStream(db, {
    streamId: "t:reset",
    source,
    reset: true,
    processor: async (c) => c.text,
    sink: async (out, c) => { events.push(c.index) },
  })
  assert.equal(r2.totalProcessed, 3)
  assert.equal(events.length, 6) // 3 original + 3 re-processed
})

test("pipeline: onProgress callback fires per chunk", async () => {
  const db = freshDb()
  const progressUpdates: number[] = []
  const source = Array.from({ length: 3 }, (_, i) => fakeChunk(i, `c${i}`, i === 2))
  await processStream(db, {
    streamId: "t:progress",
    source,
    processor: async (c) => c.text,
    sink: async (out, c) => { /* noop */ },
    onProgress: (p) => { progressUpdates.push(p.position) },
  })
  // 3 chunks, position goes 1, 2, 3 (per chunk), then final done update.
  assert.equal(progressUpdates.length, 4)
  assert.deepEqual(progressUpdates, [1, 2, 3, 3])
})
