// -----------------------------------------------------------------------------
// Auto-delivery helper
//
// When the model produces a user-facing artifact via a generation tool
// (e.g. GenerateSpeech → audio file, GenerateImage → image file) but
// forgets to follow up with the corresponding Telegram delivery tool,
// the user gets nothing. Observed 2026-06-09 23:47: the model called
// GenerateSpeech (419949 bytes) and emitted the `<gen_audio>` metadata
// tag, but never called TelegramSendVoice, so the audio never reached
// the user.
//
// The runtime now auto-injects the missing delivery tool call so the
// artifact is delivered. The runtime is the actor; the model is the
// source of intent (it called the generation tool) but not the
// bottleneck.
//
// Detection rules:
//   1. A generation tool returned a result with `local_path`.
//   2. NO `TelegramSend*` call with the same `local_path` happened in
//      the same turn.
//   3. There is an active delivery context (Telegram chat target).
//
// Mapping (intentionally narrow — false positives are worse than false
// negatives here, so we only cover the explicit production+delivery
// pairs the model gets wrong most often):
//   - GenerateSpeech  with response_format in {ogg,opus} → TelegramSendVoice
//   - GenerateSpeech  with response_format = mp3        → TelegramSendAudio
//   - GenerateImage                                       → TelegramSendPhoto
//
// The matching TelegramSend* tool is the "auto delivery" for that
// generation tool. DownloadFile, VoiceClone, etc. are out of scope:
// they don't have an obvious single-pair delivery tool, and adding
// the pair by hand keeps the helper honest.
// -----------------------------------------------------------------------------

import { parseStructuredToolCalls } from "./providers/types.ts"

export type DeliveryKind = "voice" | "audio" | "photo"

/**
 * Internal shape: what the model emitted (or didn't) this turn.
 */
export interface UndeliveredOutput {
  /** Which generation tool produced the artifact. */
  sourceTool: "GenerateSpeech" | "GenerateImage"
  /** Local file path returned by the source tool. */
  localPath: string
  /** Which Telegram delivery tool the runtime should auto-inject. */
  deliveryTool: "TelegramSendVoice" | "TelegramSendAudio" | "TelegramSendPhoto"
  /** Payload for the delivery tool call. */
  deliveryInput: Record<string, unknown>
  /** Free-text annotation for logs. */
  reason: string
}

/**
 * Inspect the messages array of the current turn and return any
 * generation outputs that the model produced but did NOT pair with the
 * matching Telegram delivery tool. Used by the agent loop to decide
 * whether to inject auto-delivery tool calls.
 *
 * Pure function: easy to unit-test, no I/O.
 */
export function findUndeliveredToolOutputs(
  messages: ReadonlyArray<{ role: string; toolName?: string; content?: string; toolCalls?: Array<{ name: string; input: unknown }> }>,
): UndeliveredOutput[] {
  const result: UndeliveredOutput[] = []

  // 1. Collect every local_path produced by a generation tool this turn.
  const produced: Array<{ tool: string; localPath: string; format: string | null }> = []
  for (const m of messages) {
    if (m.role !== "tool") continue
    if (m.toolName !== "GenerateSpeech" && m.toolName !== "GenerateImage") continue
    const path = extractLocalPath(m.content ?? "")
    if (!path) continue
    produced.push({ tool: m.toolName, localPath: path, format: extractResponseFormat(m.content ?? "") })
  }
  if (produced.length === 0) return result

  // 2. Collect every local_path the model already delivered this turn.
  const delivered = new Set<string>()
  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls) continue
    for (const tc of m.toolCalls) {
      if (tc.name !== "Telegram" && !tc.name.startsWith("TelegramSend")) continue
      // parseStructuredToolCalls expects the OpenAI-shaped item with
      // `id` + `function: { name, arguments: string }` (arguments as a
      // serialized JSON string). Adapt the in-memory toolCall into that
      // shape so the parser can extract the input.
      const synthetic = [{
        id: "check",
        function: {
          name: tc.name,
          arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {}),
        },
      }]
      const parsed = parseStructuredToolCalls(synthetic)
      const input = (parsed[0]?.input ?? {}) as Record<string, unknown>
      const sentPath = extractLocalPathValue(input)
      if (sentPath) delivered.add(sentPath)
    }
  }

  // 3. For each produced-but-not-delivered artifact, build the auto-pair.
  for (const p of produced) {
    if (delivered.has(p.localPath)) continue
    if (p.tool === "GenerateImage") {
      result.push({
        sourceTool: "GenerateImage",
        localPath: p.localPath,
        deliveryTool: "TelegramSendPhoto",
        deliveryInput: { photo: p.localPath },
        reason: `GenerateImage produced ${p.localPath} but no TelegramSendPhoto call followed.`,
      })
      continue
    }
    // GenerateSpeech → voice vs audio
    const isAudioFormat = p.format === "mp3" || p.format === "pcm_s16le" || p.format === "pcm" || p.format === "flac" || p.format === "wav"
    result.push({
      sourceTool: "GenerateSpeech",
      localPath: p.localPath,
      deliveryTool: isAudioFormat ? "TelegramSendAudio" : "TelegramSendVoice",
      deliveryInput: isAudioFormat
        ? { audio: p.localPath }
        : { voice: p.localPath },
      reason: `GenerateSpeech produced ${p.localPath} (format=${p.format ?? "unknown"}) but no ${isAudioFormat ? "TelegramSendAudio" : "TelegramSendVoice"} call followed.`,
    })
  }
  return result
}

// -----------------------------------------------------------------------------
// Internal: extract fields out of a tool result `content` string.
// The runtime serializes tool results with formatToolEvidenceResult
// (xml wrapper + JSON body), so we read the JSON body and pluck
// local_path / response_format fields.
// -----------------------------------------------------------------------------

function readEvidenceBody(content: string): Record<string, unknown> | null {
  // Strip the <tool-evidence ...>...</tool-evidence> wrapper if present
  // and parse the inner JSON.
  const stripped = content
    .replace(/^<tool-evidence[\s\S]*?>\s*/i, "")
    .replace(/\s*<\/tool-evidence>\s*$/i, "")
    .trim()
  if (!stripped.startsWith("{")) return null
  try {
    return JSON.parse(stripped) as Record<string, unknown>
  } catch {
    return null
  }
}

function extractLocalPath(content: string): string | null {
  const body = readEvidenceBody(content)
  if (!body) return null
  const path = body.local_path
  if (typeof path === "string" && path.length > 0) return path
  // Some tools use `path` instead of `local_path`.
  const alt = body.path
  if (typeof alt === "string" && alt.length > 0) return alt
  return null
}

function extractResponseFormat(content: string): string | null {
  const body = readEvidenceBody(content)
  if (!body) return null
  const fmt = body.response_format
  if (typeof fmt === "string") return fmt
  return null
}

function extractLocalPathValue(input: Record<string, unknown>): string | null {
  // TelegramSend{Photo,Voice,Audio} accepts `photo` / `voice` / `audio`
  // which can be a file_id, http URL, or local path. We only need the
  // local-path case for dedupe.
  for (const key of ["photo", "voice", "audio"]) {
    const v = input[key]
    if (typeof v === "string" && v.length > 0 && (v.startsWith("/") || v.startsWith("./") || v.startsWith("../") || v.startsWith("~/"))) {
      return v
    }
  }
  return null
}
