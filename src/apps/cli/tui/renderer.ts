import { stdout } from "node:process"
import { truncate } from "../../../core/renderer/toolRenderer.ts"
import { ANSI, padLine, truncateMiddle, visibleWidth, wrapPlainText, wrapTextWithIndent } from "./ansi.ts"
import type { ComposerState, HeaderState, MouseAction, TranscriptBlock, TranscriptViewport } from "./types.ts"

export const MAX_TRANSCRIPT_BLOCKS = 1000
export const COMPACTION_ESTIMATE_TOKEN_BUDGET = 24000

export function getPromptLabel(_sessionId: string) {
  return {
    styled: `${ANSI.purpleFluor}${ANSI.bold}>${ANSI.reset} `,
    plain: "> ",
  }
}

function getThinkingText(frame: number) {
  return `Thinking${["...", "..", "."][frame % 3] ?? "..."}`
}

function wrapTextWithSinglePrefix(text: string, width: number, firstIndent: string, restIndent: string) {
  const safeWidth = Math.max(1, width)
  const lines: string[] = []

  for (const paragraph of text.split("\n")) {
    const indent = lines.length === 0 ? firstIndent : restIndent
    if (paragraph.length === 0) {
      lines.push(indent)
      continue
    }

    const chunks = wrapPlainText(paragraph, Math.max(1, safeWidth - visibleWidth(indent)))
    lines.push(`${indent}${chunks[0] ?? ""}`)
    for (const chunk of chunks.slice(1)) {
      lines.push(`${restIndent}${chunk}`)
    }
  }

  return lines.length > 0 ? lines : [firstIndent]
}

function renderBulletedBlock(text: string, width: number, bulletColor: string) {
  return wrapTextWithSinglePrefix(text, width, `${bulletColor}${ANSI.bold}●${ANSI.reset} `, "  ")
}

export function toneColor(tone: TranscriptBlock extends { tone: infer T } ? T : never) {
  switch (tone) {
    case "info":
      return ANSI.purpleFluor
    case "success":
      return ANSI.green
    case "error":
      return ANSI.red
    default:
      return ANSI.dim
  }
}

export function renderTranscriptBlock(block: TranscriptBlock, width: number) {
  if (block.type === "assistant-meta") {
    return wrapTextWithIndent(`${ANSI.dim}${block.text}${ANSI.reset}`, width, "  ", "  ")
  }
  if (block.type === "message") {
    if (block.role === "assistant") {
      return renderBulletedBlock(block.text, width, "")
    }
    return wrapTextWithIndent(block.text, width, `${ANSI.purpleFluor}${ANSI.bold}❯${ANSI.reset} `, "  ")
  }
  if (block.tone === "error") {
    return renderBulletedBlock(block.text, width, ANSI.red)
  }
  if (block.tone === "info") {
    return renderBulletedBlock(block.text, width, ANSI.purpleFluor)
  }
  if (!block.label) {
    return renderBulletedBlock(block.text, width, "")
  }
  return renderBulletedBlock(block.text, width, "")
}

export function flattenTranscript(blocks: TranscriptBlock[], width: number) {
  const rows: string[] = []
  for (const block of blocks) {
    rows.push(...renderTranscriptBlock(block, width))
    rows.push("")
  }
  if (rows.length > 0) rows.pop()
  return rows
}

export function renderCopyTranscriptBlock(block: TranscriptBlock, width: number) {
  if (block.type === "assistant-meta") {
    return wrapTextWithIndent(block.text, width, "  ", "  ")
  }
  if (block.type === "message") {
    return block.role === "assistant"
      ? wrapTextWithSinglePrefix(block.text, width, "● ", "  ")
      : wrapTextWithIndent(block.text, width, "❯ ", "  ")
  }
  if (!block.label) return wrapTextWithIndent(block.text, width, "", "  ")
  return wrapTextWithIndent(block.text, width, `[${block.label}] `, "  ")
}

export function flattenCopyTranscript(blocks: TranscriptBlock[], width: number) {
  const rows: string[] = []
  for (const block of blocks) {
    rows.push(...renderCopyTranscriptBlock(block, width))
    rows.push("")
  }
  if (rows.length > 0) rows.pop()
  return rows
}

export function appendTranscriptBlocks(viewport: TranscriptViewport, blocks: TranscriptBlock[]) {
  if (blocks.length === 0) return viewport
  return {
    blocks: [...viewport.blocks, ...blocks].slice(-MAX_TRANSCRIPT_BLOCKS),
    scrollOffset: viewport.scrollOffset,
  }
}

export function clampScrollOffset(offset: number, totalRows: number, visibleRows: number) {
  return Math.max(0, Math.min(offset, Math.max(0, totalRows - visibleRows)))
}

export function parseMouseEvent(sequence?: string): { action: MouseAction } | null {
  if (!sequence) return null
  const match = /^\u001b\[<(\d+);(\d+);(\d+)([mM])$/.exec(sequence)
  if (!match) return null
  const button = Number.parseInt(match[1] ?? "", 10)
  if (button === 64) return { action: "scrollUp" }
  if (button === 65) return { action: "scrollDown" }
  return null
}

function estimateTokenCountFromMessages(blocks: TranscriptBlock[]) {
  const text = blocks
    .filter((block): block is Extract<TranscriptBlock, { type: "message" }> => block.type === "message")
    .map(block => block.text)
    .join("\n")
  return Math.ceil(text.length / 4)
}

function getRemainingCompactionPercent(transcript: TranscriptViewport) {
  const estimatedTokens = estimateTokenCountFromMessages(transcript.blocks)
  const remainingRatio = Math.max(0, 1 - estimatedTokens / COMPACTION_ESTIMATE_TOKEN_BUDGET)
  return Math.round(remainingRatio * 100)
}

export function getTranscriptVisibleRows(header: HeaderState, composer: ComposerState) {
  const cols = stdout.columns || 80
  const rows = stdout.rows || 24
  const composerLayout = renderComposerLines(header.sessionId, composer, cols)
  const composerRows = 1 + composerLayout.suggestionLines.length + composerLayout.inputLines.length + 1
  const headerRows = renderHeaderLines(header, cols, 100).length
  return Math.max(1, rows - headerRows - composerRows)
}

export function renderHeaderLines(header: HeaderState, cols: number, remainingCompactionPercent: number) {
  const width = Math.max(20, cols)
  const innerWidth = Math.max(1, width - 4)
  const workspaceValue = truncateMiddle(header.workspacePath, Math.max(1, innerWidth - 10))
  const titleLeft = `${ANSI.bold}${header.projectName}${ANSI.reset} v${header.version}`
  const titleRight = `${header.connected ? ANSI.green : ANSI.red}${ANSI.bold}●${ANSI.reset} ${header.connected ? "Connected" : "Disconnected"}`
  const fill = Math.max(1, innerWidth - visibleWidth(titleLeft) - visibleWidth(titleRight))
  return [
    `${ANSI.purpleFluor}╭${"─".repeat(Math.max(0, width - 2))}╮${ANSI.reset}`,
    `${ANSI.purpleFluor}│${ANSI.reset} ${titleLeft}${" ".repeat(fill)}${titleRight} ${ANSI.purpleFluor}│${ANSI.reset}`,
    `${ANSI.purpleFluor}│${ANSI.reset} ${padLine(`${ANSI.dim}workspace${ANSI.reset} ${workspaceValue}`, innerWidth)} ${ANSI.purpleFluor}│${ANSI.reset}`,
    `${ANSI.purpleFluor}│${ANSI.reset} ${padLine(`${ANSI.dim}model${ANSI.reset} ${truncate(header.model, 26)}   ${ANSI.dim}provider${ANSI.reset} ${truncate(header.provider, 20)}   ${ANSI.dim}reasoning${ANSI.reset} ${header.reasoning}   ${ANSI.dim}ctx${ANSI.reset} ${remainingCompactionPercent}%`, innerWidth)} ${ANSI.purpleFluor}│${ANSI.reset}`,
    `${ANSI.purpleFluor}│${ANSI.reset} ${padLine(`${ANSI.dim}session${ANSI.reset} ${header.sessionId.slice(0, 8)}`, innerWidth)} ${ANSI.purpleFluor}│${ANSI.reset}`,
    `${ANSI.purpleFluor}╰${"─".repeat(Math.max(0, width - 2))}╯${ANSI.reset}`,
  ]
}

export function renderComposerLines(sessionId: string, composer: ComposerState, cols: number) {
  const width = Math.max(20, cols)
  const innerWidth = Math.max(1, width - 4)
  const prompt = getPromptLabel(sessionId)
  const inputLinesPlain = wrapPlainText(`${prompt.plain}${composer.input}`, innerWidth)
  const inputLines = inputLinesPlain.map((line, index) => {
    if (index === 0 && line.startsWith(prompt.plain)) {
      return `${prompt.styled}${line.slice(prompt.plain.length)}`
    }
    return line
  })

  return {
    topBorder: `${ANSI.purpleFluor}╭${"─".repeat(Math.max(0, width - 2))}╮${ANSI.reset}`,
    suggestionLines: [],
    inputLines: inputLines.map(line => `${ANSI.purpleFluor}│${ANSI.reset} ${padLine(line, innerWidth)} ${ANSI.purpleFluor}│${ANSI.reset}`),
    bottomBorder: `${ANSI.purpleFluor}╰${"─".repeat(Math.max(0, width - 2))}╯${ANSI.reset}`,
    promptPlain: prompt.plain,
    innerWidth,
  }
}

export function renderScreen(header: HeaderState, transcript: TranscriptViewport, composer: ComposerState, forceClear = false) {
  const cols = stdout.columns || 80
  const rows = stdout.rows || 24
  const remainingCompactionPercent = getRemainingCompactionPercent(transcript)
  const headerLines = renderHeaderLines(header, cols, remainingCompactionPercent)
  const composerLayout = renderComposerLines(header.sessionId, composer, cols)
  const composerRows = 1 + composerLayout.suggestionLines.length + composerLayout.inputLines.length + 1
  const transcriptRows = Math.max(1, rows - headerLines.length - composerRows)
  // Always create a mutable copy to avoid mutating transcript.blocks
  // Don't show "Pensando..." while a tool is actively running — the tool animation replaces it
  const showThinking = composer.busy && composer.thinkingVisible && !composer.toolThinkingText
  const displayTranscriptBlocks: TranscriptBlock[] = showThinking
    ? [...transcript.blocks, { type: "message", role: "assistant", text: getThinkingText(composer.thinkingFrame) }]
    : [...transcript.blocks]

  // Animate tool thinking dots: replace trailing '...' with cycling dots on the last event block
  if (composer.toolThinkingText) {
    const dots = [".", "..", "..."]
    const animDots = dots[composer.toolThinkingFrame % 3] ?? "..."
    const animText = composer.toolThinkingText.replace(/\.{1,3}(?=(\n|$))/, animDots)
    // Search backwards for the last event block (it may not be the very last block)
    for (let i = displayTranscriptBlocks.length - 1; i >= 0; i--) {
      if (displayTranscriptBlocks[i]?.type === "event") {
        displayTranscriptBlocks[i] = { ...displayTranscriptBlocks[i], text: animText } as TranscriptBlock
        break
      }
    }
  }
  const transcriptLines = flattenTranscript(displayTranscriptBlocks, cols)
  const scrollOffset = clampScrollOffset(transcript.scrollOffset, transcriptLines.length, transcriptRows)
  const endIndex = Math.max(0, transcriptLines.length - scrollOffset)
  const startIndex = Math.max(0, endIndex - transcriptRows)
  const visibleTranscript = transcriptLines.slice(startIndex, endIndex)
  const paddedTranscript = [
    ...Array.from({ length: Math.max(0, transcriptRows - visibleTranscript.length) }, () => ""),
    ...visibleTranscript,
  ]

  const screenLines = [
    ...headerLines.map(line => padLine(line, cols)),
    ...paddedTranscript.map(line => padLine(line, cols)),
    padLine(composerLayout.topBorder, cols),
    ...composerLayout.suggestionLines.map(line => padLine(line, cols)),
    ...composerLayout.inputLines.map(line => padLine(line, cols)),
    padLine(composerLayout.bottomBorder, cols),
  ]

  const cursorPrefix = `${composerLayout.promptPlain}${composer.input.slice(0, composer.cursor)}`
  const cursorWrapped = wrapPlainText(cursorPrefix, composerLayout.innerWidth)
  const cursorRowWithinComposer = composerLayout.suggestionLines.length + Math.max(0, cursorWrapped.length - 1)
  const cursorCol = Math.min(composerLayout.innerWidth, (cursorWrapped.at(-1) ?? "").length)
  const cursorRow = headerLines.length + transcriptRows + 1 + cursorRowWithinComposer + 1

  let frame: string
  if (forceClear) {
    frame = `${ANSI.bsu}${ANSI.hideCursor}${ANSI.home}${ANSI.clearScreen}${screenLines.join("\n")}`
  } else {
    let buf = `${ANSI.bsu}${ANSI.hideCursor}`
    for (let i = 0; i < screenLines.length; i++) {
      buf += `\u001b[${i + 1};1H${screenLines[i]}${ANSI.el}`
    }
    if (screenLines.length < rows) {
      buf += `\u001b[${screenLines.length + 1};1H${ANSI.ed}`
    }
    frame = buf
  }
  const cursor = `\u001b[${cursorRow};${Math.max(3, cursorCol + 3)}H${ANSI.showCursor}${ANSI.esu}`
  stdout.write(`${frame}${cursor}`)
}

export function renderCopyModeScreen(header: HeaderState, transcript: TranscriptViewport) {
  const cols = stdout.columns || 80
  const width = Math.max(20, cols)
  const transcriptLines = flattenCopyTranscript(transcript.blocks, width)
  const title = `${header.projectName} v${header.version} · transcript`
  const status = header.connected ? "● Connected" : "● Disconnected"
  const separator = "─".repeat(width)
  const footer = "[copy mode] Select with mouse and use native terminal scroll. Back: q, Enter, Esc or Ctrl+O."
  const lines = [
    title,
    status,
    header.workspacePath,
    separator,
    ...(transcriptLines.length > 0 ? transcriptLines : ["(no messages)"]),
    "",
    separator,
    footer,
  ]
  stdout.write(`${ANSI.showCursor}${ANSI.altScreenOff}${ANSI.home}${ANSI.clearScreen}${lines.join("\n")}\n`)
}
