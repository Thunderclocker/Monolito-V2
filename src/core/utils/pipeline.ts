// Process-and-flush pipeline orchestrator.
//
// Connects: chunker + processor + sink + cursor.
//
// Flow:
//   source → chunker → [chunk] → processor(chunk) → sink(result) → advanceCursor
//                ↑                              │
//                │                              └─ on error: log warn, advance cursor (no retry)
//                └─ skips chunks with index < cursor.position (resume)
//
// Guarantees:
// - Re-ejecutable: if the process crashes between processor and sink, the
//   chunk is reprocessed on next run. **Sinks MUST be idempotent** (use
//   INSERT OR IGNORE / ON CONFLICT DO NOTHING).
// - Cancelable: AbortSignal cuts the loop at the next chunk boundary.
// - Sin pérdida: every chunk is processed at least once. The cursor
//   advances after a successful sink OR after a terminal error (the error
//   is logged and counted, but the chunk is NOT retried — this is a
//   conscious decision to avoid infinite loops on poisoned data).

import type Database from "better-sqlite3"
import { createLogger } from "../logging/logger.ts"
import { type Chunk, chunk, type ChunkOptions } from "./chunker.ts"
import {
  advanceCursor,
  getCursor,
  incrementCounters,
  type CursorState,
} from "./cursor.ts"

const logger = createLogger("pipeline")

export interface ProcessContext {
  streamId: string
  cursor: CursorState
  chunk: Chunk
}

export interface PipelineProgress {
  streamId: string
  position: number
  totalSeen: number
  totalProcessed: number
  totalErrors: number
  done: boolean
}

export interface PipelineResult {
  streamId: string
  totalProcessed: number
  totalErrors: number
  finalPosition: number
  done: boolean
}

export interface ProcessStreamOptions<S> {
  streamId: string
  /** Source: a long string, an array of pre-chunked Chunks, or an AsyncIterable. */
  source: string | AsyncIterable<Chunk> | Chunk[]
  /** Chunker options (only used when source is a string). */
  chunker?: ChunkOptions
  /**
   * Processor: handles ONE chunk. Returns a result to be passed to the sink.
   * Throw → log warn, count error, advance cursor (no retry).
   * Return null/undefined → skip silently (no error, advance cursor).
   */
  processor: (chunk: Chunk, ctx: ProcessContext) => Promise<S | null | void>
  /** Sink: persists the processor's result. MUST be idempotent. */
  sink: (result: S, chunk: Chunk, ctx: ProcessContext) => Promise<void>
  /** Optional progress callback, fired once per chunk. */
  onProgress?: (state: PipelineProgress) => void
  /** Reset cursor to position 0 before starting. Default: false. */
  reset?: boolean
  /** Parallel chunks. Default: 1 (sequential). Single-threaded async. */
  concurrency?: number
  /** Hard cap on chunks processed in this invocation. Default: Infinity. */
  maxChunks?: number
  /** External cancellation. */
  abortSignal?: AbortSignal
}

type Source = "string" | "array" | "iterable"

function detectSourceType(source: string | AsyncIterable<Chunk> | Chunk[]): Source {
  if (typeof source === "string") return "string"
  if (Array.isArray(source)) return "array"
  return "iterable"
}

async function* toAsyncIter(source: string | AsyncIterable<Chunk> | Chunk[], chunker?: ChunkOptions): AsyncIterable<Chunk> {
  const t = detectSourceType(source)
  if (t === "string") {
    const result = chunk(source as string, { ...(chunker ?? {}), stream: true })
    for await (const c of result as unknown as AsyncIterable<Chunk>) yield c
  } else if (t === "array") {
    for (const c of source as Chunk[]) yield c
  } else {
    for await (const c of source as AsyncIterable<Chunk>) yield c
  }
}

/**
 * Run the process-and-flush pipeline.
 *
 * @param db SQLite DB instance (used for the cursor table).
 * @param opts Stream config.
 */
export async function processStream<S>(
  db: Database.Database,
  opts: ProcessStreamOptions<S>,
): Promise<PipelineResult> {
  const streamId = opts.streamId
  const concurrency = Math.max(1, opts.concurrency ?? 1)
  const maxChunks = opts.maxChunks ?? Infinity
  const abortSignal = opts.abortSignal

  // Reset if requested.
  if (opts.reset) {
    const { resetCursor } = await import("./cursor.ts")
    resetCursor(db, streamId)
  }

  // Load current cursor.
  let cursor = getCursor(db, streamId)
  const startPosition = cursor.position

  let totalProcessed = 0
  let totalErrors = 0
  let totalSeen = 0
  let lastSeenPosition = startPosition
  let hitLastChunk = false
  let hitMaxChunks = false

  // Worker pool: simple queue, concurrency workers.
  type WorkItem = { chunk: Chunk }
  const queue: WorkItem[] = []
  let producersDone = false

  const worker = async (): Promise<void> => {
    while (true) {
      if (abortSignal?.aborted) return
      const item = queue.shift()
      if (!item) {
        if (producersDone) return
        // Queue empty, producer still going. Yield to event loop briefly.
        await new Promise((r) => setTimeout(r, 0))
        continue
      }
      const { chunk: c } = item
      const ctx: ProcessContext = { streamId, cursor, chunk: c }
      try {
        const result = await opts.processor(c, ctx)
        if (result === null || result === undefined) {
          // Skip silently: advance cursor, no error counted.
          cursor = advanceCursor(db, streamId, c.index + 1)
          lastSeenPosition = cursor.position
          if (opts.onProgress) {
            opts.onProgress({
              streamId,
              position: cursor.position,
              totalSeen,
              totalProcessed,
              totalErrors,
              done: false,
            })
          }
          continue
        }
        await opts.sink(result, c, ctx)
        cursor = advanceCursor(db, streamId, c.index + 1)
        incrementCounters(db, streamId, "processed")
        totalProcessed++
        lastSeenPosition = cursor.position
        if (opts.onProgress) {
          opts.onProgress({
            streamId,
            position: cursor.position,
            totalSeen,
            totalProcessed,
            totalErrors,
            done: false,
          })
        }
      } catch (e) {
        // Terminal error for this chunk: log, count, advance cursor.
        logger.warn("pipeline: chunk failed, advancing cursor", {
          streamId,
          chunkIndex: c.index,
          errorName: e instanceof Error ? e.name : "Error",
          errorMessage: e instanceof Error ? e.message : String(e),
        })
        cursor = advanceCursor(db, streamId, c.index + 1)
        incrementCounters(db, streamId, "errors")
        totalErrors++
        lastSeenPosition = cursor.position
      }
    }
  }

  // Spawn workers.
  const workers: Promise<void>[] = []
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker())
  }

  // Producer: enqueue chunks respecting the cursor position (skip already-done).
  // Also stops on abort or maxChunks.
  let chunkIndex = 0
  let producerError: Error | null = null

  try {
    for await (const c of toAsyncIter(opts.source, opts.chunker)) {
      if (abortSignal?.aborted) break
      // Honor the cursor: skip chunks that are already done.
      if (c.index < cursor.position) {
        continue
      }
      // Hard cap.
      if (totalSeen >= maxChunks) {
        hitMaxChunks = true
        break
      }
      queue.push({ chunk: c })
      chunkIndex++
      totalSeen++

      // If the chunk is "isLast", stop producing. Workers will drain queue.
      if (c.isLast) {
        hitLastChunk = true
        break
      }
    }
  } catch (e) {
    logger.error("pipeline: source iteration failed", {
      streamId,
      errorName: e instanceof Error ? e.name : "Error",
      errorMessage: e instanceof Error ? e.message : String(e),
    })
    producerError = e instanceof Error ? e : new Error(String(e))
  }

  producersDone = true
  // Drain workers.
  await Promise.all(workers)

  // done = true only if we reached the end of the source naturally (isLast) or
  // the source was exhausted (string source with no isLast) AND no abort.
  // hitMaxChunks is NOT done — caller can resume.
  // For string sources that have no isLast, the producer loop runs to completion
  // (the AsyncIterable from chunk() yields the last chunk with isLast=true).
  // For Array sources, the for-await exits when the array is exhausted; if
  // none of the chunks had isLast=true, hitLastChunk stays false. We treat
  // that as done too (the array IS the source, so exhaustion = done).
  const sourceType = detectSourceType(opts.source)
  const sourceExhausted = producerError !== null
  const done = !abortSignal?.aborted && !hitMaxChunks && (hitLastChunk || sourceExhausted || sourceType === "array")

  if (opts.onProgress) {
    opts.onProgress({
      streamId,
      position: lastSeenPosition,
      totalSeen,
      totalProcessed,
      totalErrors,
      done,
    })
  }

  return {
    streamId,
    totalProcessed,
    totalErrors,
    finalPosition: lastSeenPosition,
    done,
  }
}
