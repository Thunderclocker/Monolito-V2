import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SessionRecord } from "../ipc/protocol.ts"
import { getPaths } from "../ipc/protocol.ts"
import { appendWorklog, fileMemory } from "../session/store.ts"
import { runBackgroundTextTask } from "./modelAdapter.ts"

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

function logMemoryAgent(
  rootDir: string,
  message: string,
  data?: Record<string, unknown>,
) {
  const paths = getPaths(rootDir)
  mkdirSync(paths.logsDir, { recursive: true })
  const timestamp = new Date().toISOString()
  const suffix = data
    ? ` ${Object.entries(data)
        .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join(" ")}`
    : ""
  appendFileSync(join(paths.logsDir, "memory-agent.log"), `${timestamp} ${message}${suffix}\n`)
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function clip(value: string, maxChars: number) {
  const trimmed = value.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars).trimEnd()}...`
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const firstBrace = candidate.indexOf("{")
  const lastBrace = candidate.lastIndexOf("}")
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Memory agent did not return JSON")
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as MemoryReviewResult
}

function formatRecentConversation(session: SessionRecord) {
  return session.messages
    .slice(-MAX_RECENT_MESSAGES)
    .map(message => `${message.role.toUpperCase()}: ${clip(message.text, 800)}`)
    .join("\n\n")
}

function readCoreFile(rootDir: string, profileId: string, file: "USER" | "MEMORY") {
  const path = join(getPaths(rootDir, profileId).workspaceDir, `${file}.md`)
  if (!existsSync(path)) return ""
  return readFileSync(path, "utf8")
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
  const path = join(getPaths(rootDir, profileId).workspaceDir, `${file}.md`)
  const current = existsSync(path) ? readFileSync(path, "utf8") : ""
  const next =
    proposal.action === "replace" && proposal.old_text
      ? replaceMemoryLine(current, proposal.old_text, proposal.content)
      : appendMemoryLine(current, proposal.content)
  if (next !== current) {
    writeFileSync(path, next, "utf8")
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
    "You review conversations and decide whether to save useful long-term or medium-term user memory.",
    "Return strict JSON only. Do not use tools. Do not add markdown.",
    "Prefer saving nothing over saving weak or temporary information.",
    "",
    "Memory destinations:",
    '- USER: stable profile information about the person, such as preferences, communication style, language, boundaries, habits, and how they want to be treated.',
    '- MEMORY: durable relational context between assistant and person, repeated goals, ongoing important life context, and long-lived interaction patterns.',
    "- MEMPALACE: useful personal context that may matter in future conversations but is not stable or central enough for USER or MEMORY.",
    "",
    "Think in terms of stability and future usefulness:",
    "- Highly stable and identity-level -> USER.",
    "- Durable and important across many future conversations -> MEMORY.",
    "- Useful context, plans, worries, current situations, intentions, or medium-term life details that may help later but are not canonical -> MEMPALACE.",
    "- Trivial, purely fleeting, or not useful later -> save nothing.",
    "",
    "Contradictions:",
    "- If new information clearly updates or contradicts existing USER.md or MEMORY.md, use action='replace' and set old_text.",
    "- If the information is useful but not certain enough to replace core memory, prefer MEMPALACE.",
    "",
    "Rules:",
    `- Max ${MAX_ITEMS_PER_REVIEW} items.`,
    "- Do not require perfect permanence for MEMPALACE. It exists for context that is useful later even if it is not fully stable.",
    "- For MEMPALACE, prefer literal notes that stay close to what the person actually said. Avoid interpretive summaries when a simple factual note will do.",
    "- Write the memory in the same language used by the person in the conversation. Do not switch languages or mix English words into Spanish unless the user did so first.",
    "- Avoid advice, speculation, or invented future needs. Save the remembered fact itself, not what the assistant thinks might help.",
    "- Save only context that is likely to improve future conversations.",
    "- Never save one-off trivia with no future value.",
    "- Keep each content short, atomic, and standalone.",
    "- Confidence must be between 0 and 1.",
    `- This run was triggered by: ${trigger}.`,
    "",
    'Output schema: {"items":[{"destination":"USER|MEMORY|MEMPALACE","action":"append|replace","content":"...","old_text":"optional","confidence":0.0,"wing":"optional","room":"optional","reason":"optional"}]}',
  ].join("\n")
}

function buildUserPrompt(session: SessionRecord, rootDir: string, profileId: string) {
  const userCore = clip(readCoreFile(rootDir, profileId, "USER"), 6000)
  const memoryCore = clip(readCoreFile(rootDir, profileId, "MEMORY"), 6000)
  return [
    "Current USER.md:",
    userCore || "(empty)",
    "",
    "Current MEMORY.md:",
    memoryCore || "(empty)",
    "",
    "Recent conversation:",
    formatRecentConversation(session),
    "",
    "Decide if something should be saved for future conversations.",
    "For MEMPALACE, prefer concise factual wording that stays close to the user's wording.",
    "Keep the memory in the same language as the user's message.",
    "Do not add suggestions, advice, or speculative follow-ups to the stored content.",
    "Return JSON only.",
  ].join("\n")
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
    const result = await runBackgroundTextTask(
      rootDir,
      buildSystemPrompt(trigger),
      buildUserPrompt(session, rootDir, profileId),
    )
    text = result.text
  } catch (error) {
    logMemoryAgent(rootDir, "review.error", {
      sessionId: session.id,
      trigger,
      stage: "model_call",
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
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
    logMemoryAgent(rootDir, "review.error", {
      sessionId: session.id,
      trigger,
      stage: "json_parse",
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
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
    const updated = persistCoreMemory(rootDir, profileId, proposal.destination, proposal)
    if (updated) {
      appliedSummaries.push(`${proposal.destination}.md updated`)
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
