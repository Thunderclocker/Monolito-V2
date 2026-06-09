// Semantic text chunker with overlap.
//
// Splits long text into chunks respecting paragraph > sentence > word boundaries.
// Returns chunks with char offsets so callers can resume from a position.
// Supports both eager (Chunk[]) and lazy (AsyncIterable<Chunk>) modes.
//
// Design principle: "process-and-flush". Each chunk is self-contained, the
// caller processes it, then advances — no chunk holds the whole input in memory.
//
// Cero deps. Whitespace tokenizer by default. Token estimation uses the same
// CHARS_PER_TOKEN = 3.5 heuristic as modelAdapter.ts to stay consistent.

import { createLogger } from "../logging/logger.ts"

const logger = createLogger("chunker")

export interface Chunk {
  /** The text of the chunk (original, never truncated with ellipsis). */
  text: string
  /** Char offset (inclusive) into the original source. */
  startOffset: number
  /** Char offset (exclusive). */
  endOffset: number
  /** 0-based index of this chunk in the stream. */
  index: number
  /** Estimated tokens (chars / charsPerToken). */
  estimatedTokens: number
  /** true if this is the last chunk; no more will be emitted. */
  isLast: boolean
}

export interface ChunkerStats {
  totalChunks: number
  totalChars: number
  totalTokens: number
  avgTokensPerChunk: number
  maxTokens: number
  minTokens: number
}

export interface ChunkOptions {
  /** Target size per chunk in TOKENS. Default: 1500. */
  targetTokens?: number
  /** Overlap between consecutive chunks in TOKENS. Default: 200. */
  overlapTokens?: number
  /** Preferred cut boundaries in priority order. Default: ["paragraph","sentence"]. */
  boundaries?: Array<"paragraph" | "sentence" | "word">
  /** Approx chars per token. Default: 3.5 (matches modelAdapter.ts). */
  charsPerToken?: number
  /** If true, returns AsyncIterable<Chunk>. Default: false (returns Chunk[]). */
  stream?: boolean
}

export interface ChunkByTokensOptions {
  targetTokens: number
  overlapTokens: number
  /** Reconstructs a string from a token slice. */
  detokenize: (tokens: string[]) => string
  boundaries?: Array<"paragraph" | "sentence" | "word">
}

const SENTENCE_REGEX = /([.!?\n][\s ]+|[。！？]\s*|\n\s*\n)/g
const PARAGRAPH_REGEX = /\n\s*\n+/
const WHITESPACE_REGEX = /\s+/

/** Default tokenizer: split on whitespace. Sufficient for chunking (not for embedding). */
function defaultTokenize(text: string): string[] {
  return text.split(WHITESPACE_REGEX).filter((t) => t.length > 0)
}

function defaultDetokenize(tokens: string[]): string {
  return tokens.join(" ")
}

/** O(n) char-based token estimate. Same heuristic as modelAdapter.ts. */
export function estimateTokens(text: string, charsPerToken = 3.5): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / charsPerToken)
}

/**
 * Splits text into chunks.
 * - Eager mode (default): returns Chunk[].
 * - Stream mode (opts.stream=true): returns AsyncIterable<Chunk>.
 *
 * Algorithm:
 * 1. If text is small enough for a single chunk, return [singleChunk].
 * 2. Find cut candidates in priority order (paragraph > sentence > word).
 * 3. Greedy pack: accumulate chars until target reached, cut at best boundary.
 * 4. Apply overlap: take the last `overlapChars` from chunk[i] and prepend as the
 *    start of chunk[i+1]. The startOffset of chunk[i+1] is BEFORE its real content
 *    (it includes the overlap), so the caller can resume cleanly.
 *
 * Overlap note: chunks[i+1].startOffset is the offset in the ORIGINAL text of the
 * first char of chunk[i+1].text. So if chunk[i+1] starts with overlap from chunk[i],
 * its startOffset points to the overlap, and there IS duplicated content across
 * chunks — that's the overlap working as intended.
 */
export function chunk(text: string, opts?: ChunkOptions): Chunk[]
export function chunk(text: string, opts: ChunkOptions & { stream: true }): AsyncIterable<Chunk>
export function chunk(text: string, opts?: ChunkOptions): Chunk[] | AsyncIterable<Chunk> {
  const o: ChunkOptions = opts ?? {}
  const targetTokens = o.targetTokens ?? 1500
  const overlapTokens = o.overlapTokens ?? 200
  const charsPerToken = o.charsPerToken ?? 3.5
  const targetChars = Math.max(1, Math.floor(targetTokens * charsPerToken))
  const overlapChars = Math.max(0, Math.floor(overlapTokens * charsPerToken))
  const stream = o.stream === true

  if (text.length === 0) {
    const empty: Chunk = {
      text: "",
      startOffset: 0,
      endOffset: 0,
      index: 0,
      estimatedTokens: 0,
      isLast: true,
    }
    return stream ? asyncFromArray([empty]) : [empty]
  }

  // Single chunk if small enough.
  if (text.length <= targetChars) {
    const single: Chunk = {
      text,
      startOffset: 0,
      endOffset: text.length,
      index: 0,
      estimatedTokens: estimateTokens(text, charsPerToken),
      isLast: true,
    }
    return stream ? asyncFromArray([single]) : [single]
  }

  // Build cut candidates based on boundaries preference.
  const boundaries = o.boundaries ?? ["paragraph", "sentence"]
  const cuts = computeCutPoints(text, boundaries)
  // cuts: sorted array of char offsets where it's safe to cut (0 < cut < text.length).
  // We always allow cut at text.length (end of text).
  cuts.push(text.length)

  // Greedy pack into ranges.
  const ranges = packRanges(text.length, targetChars, cuts)
  // ranges: array of [start, end] in original-text coordinates.

  // Apply overlap by re-anchoring start of each chunk to a clean boundary
  // within the overlap window. boundaryCuts is the same set used for packing,
  // so the overlap lands on a paragraph/sentence break.
  const anchored = applyOverlap(ranges, overlapChars, text.length, cuts)

  const chunks: Chunk[] = anchored.map((range, i) => {
    const [start, end] = range
    const textSlice = text.slice(start, end)
    return {
      text: textSlice,
      startOffset: start,
      endOffset: end,
      index: i,
      estimatedTokens: estimateTokens(textSlice, charsPerToken),
      isLast: i === anchored.length - 1,
    }
  })

  if (chunks.length === 0) {
    // Defensive: should never happen because text.length > 0 → at least 1 chunk.
    logger.warn("chunker produced 0 chunks for non-empty input", { textLength: text.length })
  }

  return stream ? asyncFromArray(chunks) : chunks
}

/**
 * Chunk a pre-tokenized array. Useful when the caller already has tokens
 * (e.g. from a real tokenizer) and wants exact control over chunk size in tokens.
 */
export function chunkByTokens(tokens: string[], opts: ChunkByTokensOptions): Chunk[] {
  if (tokens.length === 0) {
    return [
      {
        text: "",
        startOffset: 0,
        endOffset: 0,
        index: 0,
        estimatedTokens: 0,
        isLast: true,
      },
    ]
  }

  const { targetTokens, overlapTokens, detokenize } = opts
  if (targetTokens <= 0) {
    throw new Error("chunkByTokens: targetTokens must be > 0")
  }
  if (overlapTokens < 0 || overlapTokens >= targetTokens) {
    throw new Error("chunkByTokens: 0 <= overlapTokens < targetTokens required")
  }

  const step = targetTokens - overlapTokens
  const chunks: Chunk[] = []
  let charCursor = 0
  let i = 0
  for (let start = 0; start < tokens.length; start += step) {
    const end = Math.min(tokens.length, start + targetTokens)
    const slice = tokens.slice(start, end)
    const text = detokenize(slice)
    const startOffset = charCursor
    const endOffset = charCursor + text.length
    charCursor = endOffset
    chunks.push({
      text,
      startOffset,
      endOffset,
      index: i++,
      estimatedTokens: slice.length,
      isLast: end === tokens.length,
    })
  }
  return chunks
}

/** Aggregate stats over a chunk array. */
export function summarizeChunks(chunks: Chunk[]): ChunkerStats {
  if (chunks.length === 0) {
    return {
      totalChunks: 0,
      totalChars: 0,
      totalTokens: 0,
      avgTokensPerChunk: 0,
      maxTokens: 0,
      minTokens: 0,
    }
  }
  const totalChars = chunks.reduce((s, c) => s + c.text.length, 0)
  const totalTokens = chunks.reduce((s, c) => s + c.estimatedTokens, 0)
  const tokenCounts = chunks.map((c) => c.estimatedTokens)
  return {
    totalChunks: chunks.length,
    totalChars,
    totalTokens,
    avgTokensPerChunk: Math.round(totalTokens / chunks.length),
    maxTokens: Math.max(...tokenCounts),
    minTokens: Math.min(...tokenCounts),
  }
}

// --- internal helpers ---

/** Build sorted, deduped cut-point offsets from boundary regexes. */
function computeCutPoints(text: string, boundaries: Array<"paragraph" | "sentence" | "word">): number[] {
  const cuts = new Set<number>()
  for (const b of boundaries) {
    if (b === "paragraph") {
      // Cut AFTER a paragraph break.
      let m: RegExpExecArray | null
      const re = new RegExp(PARAGRAPH_REGEX.source, "g")
      while ((m = re.exec(text)) !== null) {
        cuts.add(m.index + m[0].length)
      }
    } else if (b === "sentence") {
      let m: RegExpExecArray | null
      const re = new RegExp(SENTENCE_REGEX.source, "g")
      while ((m = re.exec(text)) !== null) {
        cuts.add(m.index + m[0].length)
      }
    } else if (b === "word") {
      // Cut at whitespace boundaries.
      let m: RegExpExecArray | null
      const re = new RegExp(WHITESPACE_REGEX.source, "g")
      while ((m = re.exec(text)) !== null) {
        cuts.add(m.index + m[0].length)
      }
    }
  }
  return [...cuts].filter((c) => c > 0 && c < text.length).sort((a, b) => a - b)
}

/**
 * Greedy pack: walk through the text, starting at `cursor`, and emit a range
 * [start, end] where end is the cut point closest to (but <=) cursor + targetChars.
 * If no cut point is close enough, cut at cursor + targetChars (hard cut).
 */
function packRanges(textLength: number, targetChars: number, cuts: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let cursor = 0
  while (cursor < textLength) {
    const idealEnd = cursor + targetChars
    if (idealEnd >= textLength) {
      ranges.push([cursor, textLength])
      break
    }
    // Find the largest cut <= idealEnd.
    const cut = findFloor(cuts, idealEnd)
    if (cut !== null && cut > cursor) {
      ranges.push([cursor, cut])
      cursor = cut
    } else {
      // No boundary close enough: hard cut at idealEnd.
      ranges.push([cursor, idealEnd])
      cursor = idealEnd
    }
  }
  return ranges
}

/** Binary search: largest value in sorted `arr` that is <= `target`. */
function findFloor(arr: number[], target: number): number | null {
  if (arr.length === 0) return null
  let lo = 0
  let hi = arr.length - 1
  let result: number | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= target) {
      result = arr[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/**
 * Re-anchor each chunk's start backward so it overlaps with the previous chunk.
 *
 * The re-anchor lands on the NEAREST boundary (paragraph or sentence break)
 * within the overlap window of the PREVIOUS chunk's end — this keeps chunks
 * starting on clean boundaries instead of mid-sentence.
 *
 * The first chunk keeps its original start.
 */
function applyOverlap(
  ranges: Array<[number, number]>,
  overlapChars: number,
  textLength: number,
  boundaryCuts: number[],
): Array<[number, number]> {
  if (overlapChars <= 0 || ranges.length <= 1) return ranges
  const out: Array<[number, number]> = []
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i] as [number, number]
    if (i === 0) {
      out.push(range)
      continue
    }
    const prev = out[i - 1] as [number, number]
    const prevEnd = prev[1]
    // Overlap window: [prevEnd - overlapChars, prevEnd]
    const minStart = Math.max(0, prevEnd - overlapChars)
    // Find the largest boundary cut within the overlap window.
    const cut = findFloor(boundaryCuts, prevEnd)
    let newStart: number
    if (cut !== null && cut >= minStart && cut < prevEnd) {
      newStart = cut
    } else if (cut !== null && cut < minStart) {
      // Largest boundary is BEFORE the overlap window — take it anyway to keep
      // a clean break (overlap may be smaller than requested).
      newStart = cut
    } else {
      newStart = minStart
    }
    out.push([newStart, range[1]])
  }
  return out
}

/** Convert a sync array to an AsyncIterable. */
async function* asyncFromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item
  }
}

/**
 * Aggressive head+tail shrink for embedding overflow recovery. Keeps the
 * first and last `fraction` of the text (0.4 → 80% total, 40% head + 40% tail)
 * with a marker between. Used as a last-resort fallback when even the
 * sanitized text overflows Ollama's embedding context window.
 *
 * Returns null if the text is too short to benefit from shrinking.
 */
export function headTailShrink(text: string, fraction: number): string | null {
  if (!text || text.length === 0) return null
  const f = Math.max(0.05, Math.min(0.5, fraction))
  const half = Math.floor((text.length * f) / 2)
  if (half <= 0 || text.length - 2 * half < 10) return null
  return (
    text.slice(0, half) +
    "\n\n[...shrunk for embedding recovery...]\n\n" +
    text.slice(text.length - half)
  )
}
