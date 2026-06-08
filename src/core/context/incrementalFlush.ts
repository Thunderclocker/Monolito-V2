// Incremental context flush — process-and-flush variant of smartCompactor.
//
// The legacy smartCompactSession takes the middle zone of a long session,
// concatenates it into a single big string, and asks an LLM to summarize it.
// That single LLM call is the same antipattern as the embedding 500 / memory
// consolidation 100K-token bug: a giant input to a single model call is
// fragile, slow, and prone to timeouts.
//
// Incremental flush replaces it with the process-and-flush pattern:
//   1. Iterate messages in the middle zone one at a time.
//   2. For each message, extract a cheap heuristic summary
//      (no LLM, O(n) string ops).
//   3. Persist the summary as a memory_drawer under wing="CHAT" /
//      room=sessionId. fileMemory handles the embedding (single-vector
//      or multi-chunk depending on env).
//   4. Track which messages were flushed via processing_cursors (durable
//      resume across crashes).
//   5. After flushing, the caller can deleteMessages on the middle zone
//      and the info is preserved in Memory Palace.
//
// The flow is gated by env var MONOLITO_CONTEXT_FLUSH_THRESHOLD_CHARS
// (default 150000). Below the threshold, smartCompactSession (LLM summary)
// is still used — it's a one-shot that's fine for small zones.

import type Database from "better-sqlite3"
import { processStream, type PipelineResult } from "../utils/pipeline.ts"
import { createLogger } from "../logging/logger.ts"

const logger = createLogger("incrementalFlush")

/** Feature flag (threshold). */
export function getContextFlushThresholdChars(): number {
  const raw = process.env.MONOLITO_CONTEXT_FLUSH_THRESHOLD_CHARS
  if (raw === undefined) return 150_000
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 150_000
  return n
}

export interface IncrementalFlushOptions {
  rootDir: string
  sessionId: string
  /** Wing for the flushed drawers. Default: "CHAT". */
  wing?: string
  /** Room for the flushed drawers. Default: sessionId. */
  room?: string
  /** Max messages to flush per call. Default: 30. */
  batchSize?: number
  /** External AbortSignal. */
  abortSignal?: AbortSignal
  /**
   * fileMemory function (injected to avoid circular imports). Receives
   * (rootDir, wing, room, content, profileId, key). Returns the new
   * drawer id.
   */
  fileMemory: (
    rootDir: string,
    wing: string,
    room: string,
    content: string,
    profileId: string,
    key?: string,
  ) => Promise<string>
  /** Profile id to attribute the flushed drawers to. Default: "default". */
  profileId?: string
}

export interface IncrementalFlushResult extends PipelineResult {
  drawersFiled: number
  drawersSkipped: number
}

/**
 * Run one incremental flush pass.
 *
 * Source is the middle zone of the session's raw messages. Each chunk is
 * ONE message. Processor extracts a cheap heuristic summary; sink writes
 * it via fileMemory.
 *
 * NOTE: the caller is responsible for:
 *   1. Calling getRawMessagesForSession(rootDir, sessionId).
 *   2. Slicing out the middle zone (head + tail protected).
 *   3. Calling deleteMessages on the flushed zone after this returns.
 *   4. Rewriting the first msg of the zone with is_compacted=1 + pointer.
 * See modelAdapter.ts for the orchestration glue.
 */
export async function incrementalFlushSession(
  db: Database.Database,
  rawMessages: Array<{ id: number; role: string; text: string; at?: string }>,
  opts: IncrementalFlushOptions,
): Promise<IncrementalFlushResult> {
  const streamId = `ctxflush:${opts.sessionId}`
  const wing = opts.wing ?? "CHAT"
  const room = opts.room ?? opts.sessionId
  const profileId = opts.profileId ?? "default"
  const batchSize = opts.batchSize ?? 30

  // Source: one chunk per message. isLast is set on the last chunk.
  const source = rawMessages.map((m, i) => ({
    text: JSON.stringify(m),
    startOffset: i,
    endOffset: i + 1,
    index: i,
    estimatedTokens: Math.ceil(m.text.length / 3.5),
    isLast: i === rawMessages.length - 1,
  }))

  let drawersFiled = 0
  let drawersSkipped = 0

  const result = await processStream<string>(db, {
    streamId,
    source,
    abortSignal: opts.abortSignal,
    maxChunks: batchSize,
    processor: async (chunk) => {
      let msg: { id: number; role: string; text: string; at?: string }
      try {
        msg = JSON.parse(chunk.text) as typeof msg
      } catch {
        drawersSkipped++
        return null
      }
      // Skip empty / system-only messages.
      const trimmed = msg.text.trim()
      if (trimmed.length === 0) {
        drawersSkipped++
        return null
      }
      return extractHeuristicSummary(trimmed, msg.role, msg.at)
    },
    sink: async (summary, chunk) => {
      const msg = JSON.parse(chunk.text) as { id: number; role: string; text: string; at?: string }
      // Idempotent key: msg-{id}. fileMemory + memory_drawers already dedup
      // on (wing, room, key) when key is provided (via appendPalaceNode).
      const key = `msg-${msg.id}`
      try {
        await opts.fileMemory(opts.rootDir, wing, room, summary, profileId, key)
        drawersFiled++
      } catch (e) {
        // Don't propagate — we still want the cursor to advance so we don't
        // re-attempt the same failing message every loop.
        logger.warn("incrementalFlush: fileMemory failed for msg, skipping", {
          msgId: msg.id,
          errorName: e instanceof Error ? e.name : "Error",
          errorMessage: e instanceof Error ? e.message : String(e),
        })
        drawersSkipped++
      }
    },
  })

  return {
    ...result,
    drawersFiled,
    drawersSkipped,
  }
}

// --- internal helpers ---

/**
 * Cheap heuristic summary (no LLM). Extracts:
 *   - First 2 sentences (or up to 400 chars).
 *   - Keywords: words > 4 chars, deduplicated, top 8 by frequency.
 *   - Role + timestamp prefix.
 *
 * This is intentionally lossy — the FULL content is still available in
 * memory_drawers.content if the caller wants to surface it. The summary
 * is what the embedding model sees first, and what shows in compact logs.
 */
function extractHeuristicSummary(text: string, role: string, at: string | undefined): string {
  const header = `[${role}${at ? ` ${at}` : ""}]`
  // First 2 sentences.
  const sentences = splitSentences(text)
  const firstTwo = sentences.slice(0, 2).join(" ").trim()
  let body = firstTwo
  if (body.length > 400) body = body.slice(0, 400) + "…"
  // Keywords.
  const keywords = topKeywords(text, 8)
  const kwSuffix = keywords.length > 0 ? `\n\n[Keywords: ${keywords.join(", ")}]` : ""
  return `${header} ${body}${kwSuffix}`
}

function splitSentences(text: string): string[] {
  // Simple sentence splitter. Not perfect, but good enough for summary.
  return text
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "had",
  "was", "were", "are", "been", "being", "will", "would", "should", "could",
  "their", "there", "these", "those", "what", "when", "where", "which", "while",
  "about", "because", "into", "than", "then", "also", "just", "only", "very",
  "como", "pero", "para", "este", "esta", "este", "estos", "estas", "aquel",
  "aquella", "aquelos", "aquellas", "porque", "desde", "hasta", "sobre", "bajo",
])

function topKeywords(text: string, n: number): string[] {
  const counts = new Map<string, number>()
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 4 && !STOPWORDS.has(t))
  for (const t of tokens) {
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w)
}
