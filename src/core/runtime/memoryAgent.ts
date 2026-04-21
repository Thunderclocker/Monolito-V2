import type { SessionRecord } from "../ipc/protocol.ts"
import {
  appendWorklog,
  fileMemory,
  readBootWing,
  writeBootWing,
  readCanonicalMemory,
  writeCanonicalMemory,
  type CanonicalMemorySlot,
} from "../session/store.ts"
import { runBackgroundTextTask } from "./modelAdapterLite.ts"
import type { BootWingName } from "../bootstrap/bootWings.ts"
import { createLogger } from "../logging/logger.ts"

type MemoryTrigger = "post-turn" | "pre-compact" | "session-end"

type MemoryDestination = "USER" | "MEMORY" | "MEMPALACE"

type MemoryAction = "append" | "replace"

type MemoryProposal = {
  destination: MemoryDestination
  action: MemoryAction
  content: string
  old_text?: string
  confidence?: number
  wing?: string
  room?: string
  reason?: string
}

type MemoryReviewResult = {
  items?: MemoryProposal[]
}

const MAX_RECENT_MESSAGES = 10
const MAX_ITEMS_PER_REVIEW = 2
const MIN_CONFIDENCE_FOR_CORE = 0.74
const MIN_CONFIDENCE_FOR_MEMPALACE = 0.3
const MEMORY_AGENT_TIMEOUT_MS = 20_000
const logger = createLogger("memory-agent")

function logMemoryAgent(
  _rootDir: string,
  message: string,
  data?: Record<string, unknown>,
) {
  logger.info(message, data)
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function clip(value: string, maxChars: number) {
  const trimmed = value.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars).trimEnd()}...`
}

function sanitizeJsonString(candidate: string) {
  // Remove control characters that break JSON parsing
  let sanitized = candidate.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  // Fix unescaped newlines/tabs inside JSON string values:
  // Walk through and escape literal newlines that appear between quotes
  sanitized = sanitized.replace(/"(?:[^"\\]|\\.)*"/g, match =>
    match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"),
  )
  return sanitized
}

function parseJsonCandidate(candidate: string) {
  try {
    return JSON.parse(candidate) as MemoryReviewResult
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    const sanitized = sanitizeJsonString(candidate)
    try {
      return JSON.parse(sanitized) as MemoryReviewResult
    } catch {
      // Last resort: try to fix common issues like trailing commas
      const noTrailingCommas = sanitized.replace(/,\s*([}\]])/g, "$1")
      return JSON.parse(noTrailingCommas) as MemoryReviewResult
    }
  }
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() ?? trimmed

  // Handle bare arrays like [] or [{...}] — wrap as {items: [...]}
  const firstChar = candidate.trimStart()[0]
  if (firstChar === "[") {
    const firstBracket = candidate.indexOf("[")
    const lastBracket = candidate.lastIndexOf("]")
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      try {
        const arr = JSON.parse(sanitizeJsonString(candidate.slice(firstBracket, lastBracket + 1)))
        return { items: Array.isArray(arr) ? arr : [] } as MemoryReviewResult
      } catch {
        // fall through to object parsing
      }
    }
  }

  const firstBrace = candidate.indexOf("{")
  const lastBrace = candidate.lastIndexOf("}")
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Memory agent did not return JSON")
  }
  return parseJsonCandidate(candidate.slice(firstBrace, lastBrace + 1))
}

async function runBackgroundTextTaskWithTimeout(rootDir: string, system: string, userPrompt: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MEMORY_AGENT_TIMEOUT_MS)
  try {
    return await runBackgroundTextTask(rootDir, system, userPrompt, { abortSignal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function formatRecentConversation(session: SessionRecord) {
  return session.messages
    .slice(-MAX_RECENT_MESSAGES)
    .map(message => `${message.role.toUpperCase()}: ${clip(message.text, 800)}`)
    .join("\n\n")
}

function readCoreWing(rootDir: string, profileId: string, destination: "USER" | "MEMORY") {
  const wing: BootWingName = destination === "USER" ? "BOOT_USER" : "BOOT_MEMORY"
  return readBootWing(rootDir, wing, profileId) ?? ""
}

function appendMemoryLine(content: string, line: string) {
  const trimmed = line.trim()
  if (!trimmed) return content
  const normalized = normalizeWhitespace(trimmed)
  if (normalizeWhitespace(content).includes(normalized)) return content
  const suffix = content.trimEnd().length === 0 ? "" : "\n"
  return `${content.trimEnd()}${suffix}- ${trimmed}\n`
}

function replaceMemoryLine(content: string, oldText: string, newText: string) {
  const oldTrimmed = oldText.trim()
  const newTrimmed = newText.trim()
  if (!oldTrimmed || !newTrimmed) return content
  if (content.includes(oldTrimmed)) {
    return content.replace(oldTrimmed, newTrimmed)
  }
  return appendMemoryLine(content, newTrimmed)
}

function persistCoreMemory(
  rootDir: string,
  profileId: string,
  file: "USER" | "MEMORY",
  proposal: MemoryProposal,
) {
  const wing: BootWingName = file === "USER" ? "BOOT_USER" : "BOOT_MEMORY"
  const current = readBootWing(rootDir, wing, profileId) ?? ""
  const next =
    proposal.action === "replace" && proposal.old_text
      ? replaceMemoryLine(current, proposal.old_text, proposal.content)
      : appendMemoryLine(current, proposal.content)
  if (next !== current) {
    writeBootWing(rootDir, wing, next, profileId)
    return true
  }
  return false
}

function validateProposal(proposal: MemoryProposal) {
  if (!proposal || typeof proposal !== "object") return false
  if (!["USER", "MEMORY", "MEMPALACE"].includes(proposal.destination)) return false
  if (!["append", "replace"].includes(proposal.action)) return false
  if (typeof proposal.content !== "string" || normalizeWhitespace(proposal.content).length < 8) return false
  return true
}

function shouldSkipSession(session: SessionRecord) {
  const recentUser = session.messages.filter(message => message.role === "user").slice(-2)
  if (recentUser.length === 0) return true
  const latestUserText = recentUser.at(-1)?.text.trim() ?? ""
  if (
    latestUserText.startsWith("A brand-new workspace bootstrap is pending.") ||
    latestUserText.startsWith("A new session was started via /new.") ||
    latestUserText.startsWith("Run your Session Startup sequence")
  ) {
    return true
  }
  const onlySlashCommands = recentUser.every(message => message.text.trim().startsWith("/"))
  return onlySlashCommands
}

function buildSystemPrompt(trigger: MemoryTrigger) {
  return [
    "You are Monolito's background Memory Agent.",
    "Review conversations and decide whether to save useful long-term memory.",
    "",
    "CRITICAL JSON RULES:",
    "- Return ONLY a single-line JSON object. No markdown, no code fences, no explanation.",
    "- All string values must be on ONE line. Never put literal newlines inside a JSON string.",
    "- If nothing to save, return exactly: {\"items\":[]}",
    "",
    "Destinations: USER (stable profile), MEMORY (durable context), MEMPALACE (useful but less stable).",
    "Prefer saving nothing over saving weak info. Max " + MAX_ITEMS_PER_REVIEW + " items.",
    "Write memory in the same language as the user. Keep content short and atomic.",
    "Confidence: 0 to 1. To update existing memory, use action='replace' with old_text.",
    `Trigger: ${trigger}.`,
    "",
    'Schema: {"items":[{"destination":"USER|MEMORY|MEMPALACE","action":"append|replace","content":"...","confidence":0.0}]}',
    "",
    'Example good output: {"items":[{"destination":"MEMORY","action":"append","content":"El usuario prefiere respuestas cortas.","confidence":0.85}]}',
    'Example empty: {"items":[]}',
  ].join("\n")
}

function buildUserPrompt(session: SessionRecord, rootDir: string, profileId: string) {
  const userCore = clip(readCoreWing(rootDir, profileId, "USER"), 6000)
  const memoryCore = clip(readCoreWing(rootDir, profileId, "MEMORY"), 6000)
  const canonical = readCanonicalMemory(rootDir, profileId)
  const canonicalLines = [
    canonical.assistant_name ? `assistant_name: ${canonical.assistant_name}` : null,
    canonical.user_name ? `user_name: ${canonical.user_name}` : null,
    canonical.user_preferred_name ? `user_preferred_name: ${canonical.user_preferred_name}` : null,
    canonical.user_location ? `user_location: ${canonical.user_location}` : null,
    canonical.user_timezone ? `user_timezone: ${canonical.user_timezone}` : null,
  ].filter(Boolean)
  return [
    "BOOT_USER:", userCore || "(empty)",
    "", "BOOT_MEMORY:", memoryCore || "(empty)",
    "", "CANONICAL_MEMORY:", canonicalLines.length > 0 ? canonicalLines.join("\n") : "(empty)",
    "", "Conversation:", formatRecentConversation(session),
    "", "Return JSON only. No markdown. No newlines inside strings.",
  ].join("\n")
}

function normalizeForCanonical(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function extractCanonicalUpdates(content: string, current: ReturnType<typeof readCanonicalMemory>) {
  const text = normalizeForCanonical(content)
  const updates: Array<{ slot: CanonicalMemorySlot; value: string }> = []

  const assistantNamePatterns = [
    /identidad del asistente:\s*se llama\s*['"`“”]?([^.'"`]+?)['"`“”]?(?:[.]|$)/i,
    /nombre para el asistente[^.\n]*['"`“”]([^'"`“”\n]+)['"`“”]/i,
    /(?:entonces soy|se llama)\s*['"`“”]?([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ0-9 _-]{1,40})['"`“”]?(?:[.]|$)/i,
  ]
  for (const pattern of assistantNamePatterns) {
    const match = text.match(pattern)
    const value = normalizeForCanonical(match?.[1] ?? "")
    if (value && !/^cristian$/i.test(value)) {
      updates.push({ slot: "assistant_name", value })
      break
    }
  }

  const locationMatch = text.match(/vive en\s+([^.\n]+(?:,\s*[^.\n]+){0,4})/i)
  const location = normalizeForCanonical(locationMatch?.[1] ?? "")
  if (location) {
    updates.push({ slot: "user_location", value: location })
  }

  const preferredMatch = text.match(/prefiere ser llamado\s+([^.\n]+)/i)
  const preferred = normalizeForCanonical(preferredMatch?.[1] ?? "")
  if (preferred) {
    updates.push({ slot: "user_preferred_name", value: preferred })
  } else if (/prefiere su nombre sin apodo/i.test(text) && current.user_name) {
    updates.push({ slot: "user_preferred_name", value: current.user_name })
  }

  const timezoneMatch = text.match(/zona horaria:\s*([^.\n]+)/i)
  const timezone = normalizeForCanonical(timezoneMatch?.[1] ?? "")
  if (timezone && !/por definir/i.test(timezone)) {
    updates.push({ slot: "user_timezone", value: timezone })
  }

  const unique = new Map<CanonicalMemorySlot, string>()
  for (const update of updates) {
    if (!update.value) continue
    unique.set(update.slot, update.value)
  }
  return [...unique.entries()].map(([slot, value]) => ({ slot, value }))
}

export async function runMemoryAgentReview(
  rootDir: string,
  session: SessionRecord,
  profileId: string,
  trigger: MemoryTrigger,
) {
  logMemoryAgent(rootDir, "review.start", {
    sessionId: session.id,
    profileId,
    trigger,
    messageCount: session.messages.length,
  })
  if (shouldSkipSession(session)) {
    logMemoryAgent(rootDir, "review.skip", {
      sessionId: session.id,
      trigger,
      reason: "session_filtered",
    })
    return
  }

  let text = ""
  try {
    const result = await runBackgroundTextTaskWithTimeout(
      rootDir,
      buildSystemPrompt(trigger),
      buildUserPrompt(session, rootDir, profileId),
    )
    text = result.text
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logMemoryAgent(rootDir, "review.error", {
      sessionId: session.id,
      trigger,
      stage: "model_call",
      error: message,
    })
    appendWorklog(rootDir, session.id, {
      type: "note",
      summary: `Memory agent skipped after model failure (${trigger}): ${clip(message, 160)}`,
    })
    return
  }

  logMemoryAgent(rootDir, "review.model_response", {
    sessionId: session.id,
    trigger,
    chars: text.length,
    preview: clip(text, 240),
  })

  let parsed: MemoryReviewResult
  try {
    parsed = extractJsonObject(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logMemoryAgent(rootDir, "review.error", {
      sessionId: session.id,
      trigger,
      stage: "json_parse",
      error: message,
    })
    appendWorklog(rootDir, session.id, {
      type: "note",
      summary: `Memory agent skipped after invalid JSON (${trigger}): ${clip(message, 160)}`,
    })
    return
  }
  const proposals = Array.isArray(parsed.items) ? parsed.items.slice(0, MAX_ITEMS_PER_REVIEW) : []
  if (proposals.length === 0) {
    logMemoryAgent(rootDir, "review.noop", {
      sessionId: session.id,
      trigger,
      reason: "no_proposals",
    })
    return
  }

  const appliedSummaries: string[] = []
  const canonicalBefore = readCanonicalMemory(rootDir, profileId)
  for (const proposal of proposals) {
    if (!validateProposal(proposal)) {
      logMemoryAgent(rootDir, "proposal.skip", {
        sessionId: session.id,
        trigger,
        reason: "invalid_proposal",
        proposal,
      })
      continue
    }
    const confidence = typeof proposal.confidence === "number" ? proposal.confidence : 0
    if (proposal.destination === "MEMPALACE") {
      if (confidence < MIN_CONFIDENCE_FOR_MEMPALACE) {
        logMemoryAgent(rootDir, "proposal.skip", {
          sessionId: session.id,
          trigger,
          reason: "low_confidence_mempalace",
          confidence,
          destination: proposal.destination,
          content: clip(proposal.content, 120),
        })
        continue
      }
      const wing = proposal.wing?.trim() || "PERSONAL"
      const room = proposal.room?.trim() || "signals"
      try {
        await fileMemory(rootDir, wing, room, proposal.content.trim(), profileId)
        appliedSummaries.push(`MemPalace updated (${wing}/${room})`)
        logMemoryAgent(rootDir, "proposal.applied", {
          sessionId: session.id,
          trigger,
          destination: "MEMPALACE",
          wing,
          room,
          confidence,
          content: clip(proposal.content, 120),
        })
      } catch (error) {
        logMemoryAgent(rootDir, "proposal.skip", {
          sessionId: session.id,
          trigger,
          reason: "mempalace_write_failed",
          destination: proposal.destination,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      continue
    }
    if (confidence < MIN_CONFIDENCE_FOR_CORE) {
      logMemoryAgent(rootDir, "proposal.skip", {
        sessionId: session.id,
        trigger,
        reason: "low_confidence_core",
        confidence,
        destination: proposal.destination,
        content: clip(proposal.content, 120),
      })
      continue
    }
    let updated = false
    try {
      updated = persistCoreMemory(rootDir, profileId, proposal.destination, proposal)
    } catch (error) {
      logMemoryAgent(rootDir, "proposal.skip", {
        sessionId: session.id,
        trigger,
        reason: "boot_write_failed",
        destination: proposal.destination,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (updated) {
      appliedSummaries.push(proposal.destination === "USER" ? "BOOT_USER updated" : "BOOT_MEMORY updated")
      logMemoryAgent(rootDir, "proposal.applied", {
        sessionId: session.id,
        trigger,
        destination: proposal.destination,
        action: proposal.action,
        confidence,
        content: clip(proposal.content, 120),
      })
    } else {
      logMemoryAgent(rootDir, "proposal.skip", {
        sessionId: session.id,
        trigger,
        reason: "no_effect",
        destination: proposal.destination,
        action: proposal.action,
        content: clip(proposal.content, 120),
      })
    }

    const canonicalUpdates = extractCanonicalUpdates(proposal.content, canonicalBefore)
    for (const update of canonicalUpdates) {
      try {
        const result = await writeCanonicalMemory(rootDir, update.slot, update.value, profileId)
        if (result.changed) {
          appliedSummaries.push(`CanonicalMemory updated (${update.slot})`)
          ;(canonicalBefore as Record<string, string | undefined>)[update.slot] = update.value
          logMemoryAgent(rootDir, "proposal.applied", {
            sessionId: session.id,
            trigger,
            destination: "CANONICAL",
            slot: update.slot,
            value: clip(update.value, 120),
          })
        }
      } catch (error) {
        logMemoryAgent(rootDir, "proposal.skip", {
          sessionId: session.id,
          trigger,
          reason: "canonical_write_failed",
          destination: "CANONICAL",
          slot: update.slot,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  if (appliedSummaries.length > 0) {
    appendWorklog(rootDir, session.id, {
      type: "note",
      summary: `Memory agent: ${appliedSummaries.join(" · ")}`,
    })
    logMemoryAgent(rootDir, "review.done", {
      sessionId: session.id,
      trigger,
      applied: appliedSummaries,
    })
  } else {
    logMemoryAgent(rootDir, "review.noop", {
      sessionId: session.id,
      trigger,
      reason: "no_applied_changes",
    })
  }
}
