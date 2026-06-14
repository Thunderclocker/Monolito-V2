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
  return `Processing${["...", "..", "."][frame % 3] ?? "..."}`
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

export function renderTranscriptBlock(block: TranscriptBlock, width: number, showThinkingContent = false) {
  if (block.type === "assistant-meta") {
    return wrapTextWithIndent(`${ANSI.dim}${block.text}${ANSI.reset}`, width, "  ", "  ")
  }
  if (block.type === "todo-list") {
    const lines: string[] = []
    const header = `${ANSI.dim}▼ Tasks (${block.completed}/${block.total})${ANSI.reset}`
    lines.push(wrapTextWithIndent(header, width, "  ", "  ")[0] ?? header)
    for (const item of block.items) {
      let bullet: string
      let label: string
      if (item.status === "completed") {
        bullet = `${ANSI.dim}✓${ANSI.reset}`
        label = `${ANSI.dim}${item.content}${ANSI.reset}`
      } else if (item.status === "in_progress") {
        bullet = `${ANSI.purpleFluor}▶${ANSI.reset}`
        label = `${ANSI.purpleFluor}${item.activeForm || item.content}${ANSI.reset}`
      } else {
        bullet = `${ANSI.dim}○${ANSI.reset}`
        label = item.content
      }
      const row = `${bullet} ${label}`
      lines.push(...wrapTextWithIndent(row, width, "    ", "    "))
    }
    return lines
  }
  if (block.type === "message") {
    if (block.role === "assistant") {
      const lines: string[] = []
      if ((block as any).thinking) {
        const thinkingText = (block as any).thinking
        const tokenEstimate = Math.ceil(thinkingText.length / 4)
        const tokenStr = tokenEstimate >= 1000 ? `${(tokenEstimate / 1000).toFixed(1)}k` : String(tokenEstimate)
        if (showThinkingContent) {
          lines.push(`  ${ANSI.dim}💭 Thinking... (${tokenStr} tokens) ▼${ANSI.reset}`)
          const thinkingLines = wrapTextWithIndent(thinkingText, width - 4, `${ANSI.dim}│ `, `${ANSI.dim}│ `)
          lines.push(...thinkingLines.map(l => `  ${l}${ANSI.reset}`))
        } else {
          lines.push(`  ${ANSI.dim}💭 Thinking... (${tokenStr} tokens) ▶${ANSI.reset}`)
        }
      }
      lines.push(...renderBulletedBlock(block.text, width, ""))
      return lines
    }
    return wrapTextWithIndent(block.text, width, `${ANSI.purpleFluor}${ANSI.bold}❯${ANSI.reset} `, "  ")
  }
  if (block.type === "event") {
    if (block.tone === "error") {
      return renderBulletedBlock(block.text, width, ANSI.red)
    }
    if (block.tone === "info") {
      return renderBulletedBlock(block.text, width, ANSI.purpleFluor)
    }
    if (block.tone === "success") {
      return renderBulletedBlock(block.text, width, ANSI.green)
    }
    return renderBulletedBlock(block.text, width, "")
  }
  return renderBulletedBlock("", width, "")
}

export function flattenTranscript(blocks: TranscriptBlock[], width: number, showThinkingContent = false) {
  // 1. Identify which blocks are part of MemoryAgent runs.
  // We scan the blocks array and group sequences of non-message blocks.
  // If a sequence contains any block whose text contains "MemoryAgent" or is marked as isMemoryAgent,
  // then all event and meta blocks in that sequence are tagged as memory agent blocks.
  const taggedBlocks = blocks.map(b => ({ ...b, isMemoryAgent: (b as any).isMemoryAgent }));
  
  let seqStart = -1;
  let hasMemoryAgent = false;
  
  for (let i = 0; i < taggedBlocks.length; i++) {
    const b = taggedBlocks[i];
    const isEventOrMeta = b.type === "event" || b.type === "assistant-meta" || b.type === "todo-list";
    
    if (isEventOrMeta) {
      if (seqStart === -1) {
        seqStart = i;
        hasMemoryAgent = false;
      }
      if (b.type === "event" && (b.isMemoryAgent || b.text.includes("MemoryAgent"))) {
        hasMemoryAgent = true;
      }
    } else {
      // End of sequence
      if (seqStart !== -1 && hasMemoryAgent) {
        for (let j = seqStart; j < i; j++) {
          if (taggedBlocks[j].type === "event" || taggedBlocks[j].type === "assistant-meta") {
            (taggedBlocks[j] as any).isMemoryAgent = true;
          }
        }
      }
      seqStart = -1;
      hasMemoryAgent = false;
    }
  }
  if (seqStart !== -1 && hasMemoryAgent) {
    for (let j = seqStart; j < taggedBlocks.length; j++) {
      if (taggedBlocks[j].type === "event" || taggedBlocks[j].type === "assistant-meta") {
        (taggedBlocks[j] as any).isMemoryAgent = true;
      }
    }
  }

  const rows: string[] = []
  
  if (showThinkingContent) {
    for (const block of taggedBlocks) {
      rows.push(...renderTranscriptBlock(block, width, showThinkingContent))
      rows.push("")
    }
  } else {
    let i = 0
    while (i < taggedBlocks.length) {
      const block = taggedBlocks[i]
      if ((block.type === "event" || block.type === "assistant-meta") && (block as any).isMemoryAgent) {
        let start = i
        while (
          i < taggedBlocks.length &&
          (taggedBlocks[i].type === "event" || taggedBlocks[i].type === "assistant-meta") &&
          (taggedBlocks[i] as any).isMemoryAgent
        ) {
          i++
        }
        const memBlocks = taggedBlocks.slice(start, i)
        let statusText = ""
        const eventBlocks = memBlocks.filter(b => b.type === "event") as Extract<TranscriptBlock, { type: "event" }>[]
        const lastBlock = eventBlocks[eventBlocks.length - 1] || memBlocks[memBlocks.length - 1]
        
        const completionBlock = [...eventBlocks].reverse().find(b => 
          b.text.includes("✅") || b.text.includes("CONSOLIDATION_OK") || b.text.includes("❌") || b.text.includes("sin mensajes nuevos")
        )
        
        if (completionBlock) {
          statusText = completionBlock.text.replace(/\r?\n/g, " ").trim()
        } else {
          statusText = lastBlock.text.replace(/\r?\n/g, " ").trim()
        }
        
        const maxTextLen = Math.max(10, width - 35)
        if (statusText.length > maxTextLen) {
          statusText = statusText.slice(0, maxTextLen) + "..."
        }
        
        const summaryLine = `${ANSI.dim}● 🧠 MemoryAgent: ${statusText} (Ctrl+O to expand)${ANSI.reset}`
        rows.push(summaryLine)
        rows.push("")
      } else {
        rows.push(...renderTranscriptBlock(block, width, showThinkingContent))
        rows.push("")
        i++
      }
    }
  }
  
  if (rows.length > 0) rows.pop()
  return rows
}

export function renderCopyTranscriptBlock(block: TranscriptBlock, width: number, showThinkingContent = false) {
  if (block.type === "assistant-meta") {
    return wrapTextWithIndent(block.text, width, "  ", "  ")
  }
  if (block.type === "todo-list") {
    const lines: string[] = []
    lines.push(`Tasks (${block.completed}/${block.total}):`)
    for (const item of block.items) {
      const bullet = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]"
      const label = item.status === "in_progress" && item.activeForm ? item.activeForm : item.content
      lines.push(`  ${bullet} ${label}`)
    }
    return lines
  }
  if (block.type === "message") {
    if (block.role === "assistant") {
      const lines: string[] = []
      if ((block as any).thinking) {
        const thinkingText = (block as any).thinking
        const tokenEstimate = Math.ceil(thinkingText.length / 4)
        const tokenStr = tokenEstimate >= 1000 ? `${(tokenEstimate / 1000).toFixed(1)}k` : String(tokenEstimate)
        if (showThinkingContent) {
          lines.push(`  💭 Thinking... (${tokenStr} tokens)`)
          lines.push(...wrapTextWithIndent(thinkingText, width - 4, "  │ ", "  │ "))
        } else {
          lines.push(`  💭 Thinking... (${tokenStr} tokens)`)
        }
      }
      lines.push(...wrapTextWithSinglePrefix(block.text, width, "● ", "  "))
      return lines
    }
    return wrapTextWithIndent(block.text, width, "❯ ", "  ")
  }
  if (block.type === "event") {
    if (!block.label) return wrapTextWithIndent(block.text, width, "", "  ")
    return wrapTextWithIndent(block.text, width, `[${block.label}] `, "  ")
  }
  return []
}

export function flattenCopyTranscript(blocks: TranscriptBlock[], width: number, showThinkingContent = false) {
  // 1. Identify which blocks are part of MemoryAgent runs.
  const taggedBlocks = blocks.map(b => ({ ...b, isMemoryAgent: (b as any).isMemoryAgent }));
  
  let seqStart = -1;
  let hasMemoryAgent = false;
  
  for (let i = 0; i < taggedBlocks.length; i++) {
    const b = taggedBlocks[i];
    const isEventOrMeta = b.type === "event" || b.type === "assistant-meta" || b.type === "todo-list";
    
    if (isEventOrMeta) {
      if (seqStart === -1) {
        seqStart = i;
        hasMemoryAgent = false;
      }
      if (b.type === "event" && (b.isMemoryAgent || b.text.includes("MemoryAgent"))) {
        hasMemoryAgent = true;
      }
    } else {
      // End of sequence
      if (seqStart !== -1 && hasMemoryAgent) {
        for (let j = seqStart; j < i; j++) {
          if (taggedBlocks[j].type === "event" || taggedBlocks[j].type === "assistant-meta") {
            (taggedBlocks[j] as any).isMemoryAgent = true;
          }
        }
      }
      seqStart = -1;
      hasMemoryAgent = false;
    }
  }
  if (seqStart !== -1 && hasMemoryAgent) {
    for (let j = seqStart; j < taggedBlocks.length; j++) {
      if (taggedBlocks[j].type === "event" || taggedBlocks[j].type === "assistant-meta") {
        (taggedBlocks[j] as any).isMemoryAgent = true;
      }
    }
  }

  const rows: string[] = []
  
  if (showThinkingContent) {
    for (const block of taggedBlocks) {
      rows.push(...renderCopyTranscriptBlock(block, width, showThinkingContent))
      rows.push("")
    }
  } else {
    let i = 0
    while (i < taggedBlocks.length) {
      const block = taggedBlocks[i]
      if ((block.type === "event" || block.type === "assistant-meta") && (block as any).isMemoryAgent) {
        let start = i
        while (
          i < taggedBlocks.length &&
          (taggedBlocks[i].type === "event" || taggedBlocks[i].type === "assistant-meta") &&
          (taggedBlocks[i] as any).isMemoryAgent
        ) {
          i++
        }
        const memBlocks = taggedBlocks.slice(start, i)
        let statusText = ""
        const eventBlocks = memBlocks.filter(b => b.type === "event") as Extract<TranscriptBlock, { type: "event" }>[]
        const lastBlock = eventBlocks[eventBlocks.length - 1] || memBlocks[memBlocks.length - 1]
        
        const completionBlock = [...eventBlocks].reverse().find(b => 
          b.text.includes("✅") || b.text.includes("CONSOLIDATION_OK") || b.text.includes("❌") || b.text.includes("sin mensajes nuevos")
        )
        
        if (completionBlock) {
          statusText = completionBlock.text.replace(/\r?\n/g, " ").trim()
        } else {
          statusText = lastBlock.text.replace(/\r?\n/g, " ").trim()
        }
        
        const maxTextLen = Math.max(10, width - 35)
        if (statusText.length > maxTextLen) {
          statusText = statusText.slice(0, maxTextLen) + "..."
        }
        
        const summaryLine = `● [MemoryAgent] ${statusText} (Ctrl+O to expand)`
        rows.push(summaryLine)
        rows.push("")
      } else {
        rows.push(...renderCopyTranscriptBlock(block, width, showThinkingContent))
        rows.push("")
        i++
      }
    }
  }
  
  if (rows.length > 0) rows.pop()
  return rows
}

export function appendTranscriptBlocks(viewport: TranscriptViewport, blocks: TranscriptBlock[]) {
  if (blocks.length === 0) return viewport
  let nextBlocks = viewport.blocks
  for (const block of blocks) {
    if (block.type === "message" && block.role === "user") {
      let replaced = false
      for (let i = nextBlocks.length - 1; i >= 0; i--) {
        const b = nextBlocks[i]
        if (b.type === "message" && b.role === "user") {
          const cleanA = b.text.trim()
          const cleanB = block.text.trim()
          if (cleanA === cleanB || cleanB.startsWith(cleanA) || cleanA.startsWith(cleanB)) {
            const newBlocks = [...nextBlocks]
            newBlocks[i] = block
            nextBlocks = newBlocks
            replaced = true
            break
          }
        }
      }
      if (replaced) continue
    }

    if (block.type === "event" && block.toolUseId) {
      let foundIndex = -1
      for (let i = nextBlocks.length - 1; i >= 0; i--) {
        const b = nextBlocks[i]
        if (b.type === "event" && b.toolUseId === block.toolUseId) {
          foundIndex = i
          break
        }
      }
      if (foundIndex !== -1) {
        const { replacesLastEvent: _drop, ...rest } = block
        const newBlocks = [...nextBlocks]
        newBlocks[foundIndex] = rest as TranscriptBlock
        nextBlocks = newBlocks
        continue
      }
    }

    if (block.type === "event" && block.replacesLastEvent && nextBlocks.length > 0) {
      // In-place mutation of the last event block (fallback)
      const { replacesLastEvent: _drop, ...rest } = block
      nextBlocks = [...nextBlocks.slice(0, -1), rest as TranscriptBlock]
    } else {
      nextBlocks = [...nextBlocks, block]
    }
  }
  return {
    blocks: nextBlocks.slice(-MAX_TRANSCRIPT_BLOCKS),
    scrollOffset: viewport.scrollOffset,
  }
}

export function clampScrollOffset(offset: number, totalRows: number, visibleRows: number) {
  return Math.max(0, Math.min(offset, Math.max(0, totalRows - visibleRows)))
}

/** Scroll so the start of a transcript block is visible when it exceeds the viewport. */
export function scrollOffsetToRevealBlockStart(
  blocks: TranscriptBlock[],
  blockIndex: number,
  width: number,
  visibleRows: number,
): number {
  if (blockIndex < 0 || blockIndex >= blocks.length) return 0
  const allLines = flattenTranscript(blocks, width)
  const linesBefore = flattenTranscript(blocks.slice(0, blockIndex), width)
  const blockLines = flattenTranscript([blocks[blockIndex]!], width)
  if (blockLines.length <= visibleRows) return 0
  const blockStart = linesBefore.length
  const endIndex = blockStart + visibleRows
  return clampScrollOffset(allLines.length - endIndex, allLines.length, visibleRows)
}

export function appendTranscriptBlocksAligned(
  viewport: TranscriptViewport,
  blocks: TranscriptBlock[],
  width: number,
  visibleRows: number,
): TranscriptViewport {
  const next = appendTranscriptBlocks(viewport, blocks)
  if (blocks.length === 0) return next
  const blockIndex = next.blocks.length - 1
  return {
    ...next,
    scrollOffset: scrollOffsetToRevealBlockStart(next.blocks, blockIndex, width, visibleRows),
  }
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
    header.minimaxBalance !== null
      ? `${ANSI.purpleFluor}│${ANSI.reset} ${padLine(`${ANSI.dim}token${ANSI.reset} ${header.minimaxBalance}`, innerWidth)} ${ANSI.purpleFluor}│${ANSI.reset}`
      : `${ANSI.purpleFluor}│${ANSI.reset} ${" ".repeat(innerWidth)} ${ANSI.purpleFluor}│${ANSI.reset}`,
    `${ANSI.purpleFluor}╰${"─".repeat(Math.max(0, width - 2))}╯${ANSI.reset}`,
  ]
}

export function renderComposerLines(sessionId: string, composer: ComposerState, cols: number) {
  const width = Math.max(20, cols)
  const innerWidth = Math.max(1, width - 4)
  const prompt = getPromptLabel(sessionId)
  
  let inputLinesPlain: string[]
  if (composer.permissionPrompt) {
    const p = composer.permissionPrompt
    inputLinesPlain = [
      `${ANSI.yellow}${ANSI.bold}⚠️ DESTRUCTIVE ACTION DETECTED:${ANSI.reset} Tool ${p.tool} wants to execute:`,
      `  ${ANSI.red}${ANSI.bold}${p.path}${ANSI.reset}`,
      `  Reason: ${p.reason}`,
      `  [A]llow once  ·  [S]ave always  ·  [D]eny`,
    ]
  } else {
    inputLinesPlain = wrapPlainText(`${prompt.plain}${composer.input}`, innerWidth)
  }

  const inputLines = inputLinesPlain.map((line, index) => {
    if (composer.permissionPrompt) return line
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
    ? [...transcript.blocks, {
        type: "message",
        role: "assistant",
        text: getThinkingText(composer.thinkingFrame),
        ...(composer.accumulatedThinking ? { thinking: composer.accumulatedThinking } : {})
      }]
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
  const transcriptLines = flattenTranscript(displayTranscriptBlocks, cols, composer.showThinkingContent)
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
  const cursor = composer.permissionPrompt
    ? `${ANSI.hideCursor}`
    : `\u001b[${cursorRow};${Math.max(3, cursorCol + 3)}H${ANSI.showCursor}${ANSI.esu}`
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
