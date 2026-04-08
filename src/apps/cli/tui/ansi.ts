export const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  cyan: "\u001b[36m",
  purpleFluor: "\u001b[38;2;191;0;255m",
  bold: "\u001b[1m",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  altScrollOff: "\u001b[?1007l",
  altScreenOn: "\u001b[?1049h",
  altScreenOff: "\u001b[?1049l",
  home: "\u001b[H",
  clearScreen: "\u001b[2J",
  bsu: "\u001b[?2026h",
  esu: "\u001b[?2026l",
  el: "\u001b[K",
  ed: "\u001b[J",
}

export const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g

export function stripAnsi(text: string) {
  return text.replace(ANSI_RE, "")
}

export function visibleWidth(text: string) {
  return stripAnsi(text).length
}

export function padLine(text: string, width: number) {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`
}

export function truncateMiddle(text: string, max: number) {
  if (text.length <= max) return text
  if (max <= 3) return text.slice(0, max)
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

export function tokenizeAnsi(line: string) {
  const tokens: Array<{ type: "ansi" | "text"; value: string }> = []
  let lastIndex = 0
  for (const match of line.matchAll(ANSI_RE)) {
    if (match.index === undefined) continue
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: line.slice(lastIndex, match.index) })
    }
    tokens.push({ type: "ansi", value: match[0] })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < line.length) {
    tokens.push({ type: "text", value: line.slice(lastIndex) })
  }
  return tokens
}

export function wrapPlainText(text: string, width: number) {
  if (width <= 0) return [""]
  const lines: string[] = []
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      lines.push("")
      continue
    }
    let index = 0
    while (index < rawLine.length) {
      lines.push(rawLine.slice(index, index + width))
      index += width
    }
  }
  return lines.length > 0 ? lines : [""]
}

export function wrapAnsiText(text: string, width: number) {
  if (width <= 0) return [""]
  const wrapped: string[] = []
  for (const rawLine of text.split("\n")) {
    const tokens = tokenizeAnsi(rawLine)
    let activeStyles = ""
    let buffer = ""
    let visible = 0

    const flush = () => {
      const content = buffer.length > 0 ? buffer : activeStyles
      wrapped.push(content.length > 0 ? `${content}${ANSI.reset}` : "")
      buffer = activeStyles
      visible = 0
    }

    if (tokens.length === 0) {
      wrapped.push("")
      continue
    }

    for (const token of tokens) {
      if (token.type === "ansi") {
        buffer += token.value
        if (token.value.endsWith("m")) {
          activeStyles = token.value === ANSI.reset ? "" : `${activeStyles}${token.value}`
        }
        continue
      }
      for (const char of token.value) {
        if (visible >= width) flush()
        buffer += char
        visible += 1
      }
    }

    if (visible > 0 || buffer.length > 0) {
      wrapped.push(buffer.length > 0 ? `${buffer}${ANSI.reset}` : "")
    }
  }
  return wrapped.length > 0 ? wrapped : [""]
}

export function wrapTextWithIndent(text: string, width: number, firstIndent: string, restIndent: string) {
  const safeWidth = Math.max(1, width)
  const plainFirstIndent = visibleWidth(firstIndent)
  const plainRestIndent = visibleWidth(restIndent)
  const paragraphs = text.split("\n")
  const lines: string[] = []

  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    if (paragraph.length === 0) {
      lines.push(paragraphIndex === 0 ? firstIndent : restIndent)
      continue
    }

    const firstWidth = Math.max(1, safeWidth - plainFirstIndent)
    const restWidth = Math.max(1, safeWidth - plainRestIndent)
    const chunks = wrapPlainText(paragraph, firstWidth)
    lines.push(`${firstIndent}${chunks[0] ?? ""}`)
    for (const chunk of chunks.slice(1)) {
      const wrappedChunk = wrapPlainText(chunk, restWidth)
      for (const nested of wrappedChunk) {
        lines.push(`${restIndent}${nested}`)
      }
    }
  }

  return lines.length > 0 ? lines : [firstIndent]
}
