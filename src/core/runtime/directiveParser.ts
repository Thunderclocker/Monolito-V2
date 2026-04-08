export type ToolCallDirective = {
  mode: "tool"
  tool: string
  input: Record<string, unknown>
}

export type FinalDirective = {
  mode: "final"
  message: string
}

export type ToolBatchDirective = {
  mode: "tools"
  tools: ToolCallDirective[]
}

function normalizeDirectiveCandidate(candidate: string) {
  return candidate.trim().replace(/^minimax:tool_call\s*/i, "").replace(/^tool_call\s*/i, "").trim()
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function parseMinimaxToolCall(text: string): ToolCallDirective | null {
  const invokeMatch = text.match(/<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/i)
  if (!invokeMatch) {
    const commandMatch = text.match(/<minimax:tool_call\b[^>]*>[\s\S]*?<command>([\s\S]*?)<\/command>/i)
    if (commandMatch) {
      return { mode: "tool", tool: "Bash", input: { command: decodeXmlEntities((commandMatch[1] ?? "").trim()) } }
    }
    return null
  }

  const [, toolName, body] = invokeMatch
  const input: Record<string, unknown> = {}
  const parameterMatches = body.matchAll(/<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi)

  for (const match of parameterMatches) {
    const parameterName = match[1]?.trim()
    const rawValue = decodeXmlEntities((match[2] ?? "").trim())
    if (!parameterName) continue
    if (parameterName === "input") {
      try {
        return {
          mode: "tool",
          tool: toolName.trim(),
          input: JSON.parse(rawValue) as Record<string, unknown>,
        }
      } catch {
        input.input = rawValue
        continue
      }
    }
    input[parameterName] = rawValue
  }

  return { mode: "tool", tool: toolName.trim(), input }
}

function parseBracketToolCall(text: string): ToolCallDirective | null {
  const blockMatch = text.match(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/i)
  if (!blockMatch) return null
  const block = blockMatch[1] ?? ""
  const toolMatch = block.match(/tool\s*=>\s*"([^"]+)"/i)
  if (!toolMatch) return null

  const tool = toolMatch[1]!.trim()
  const commandMatch = block.match(/--command\s+"([\s\S]*?)"/i)
  if (commandMatch) {
    return { mode: "tool", tool, input: { command: decodeXmlEntities(commandMatch[1] ?? "") } }
  }

  const inputMatch = block.match(/--input\s+(\{[\s\S]*\})/i)
  if (inputMatch) {
    try {
      return {
        mode: "tool",
        tool,
        input: JSON.parse(inputMatch[1]!) as Record<string, unknown>,
      }
    } catch {}
  }
  return { mode: "tool", tool, input: {} }
}

function normalizeToolEntry(value: unknown): ToolCallDirective | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const parsed = value as Record<string, unknown>
  if (typeof parsed.tool === "string" && parsed.input && typeof parsed.input === "object" && !Array.isArray(parsed.input)) {
    return { mode: "tool", tool: parsed.tool, input: parsed.input as Record<string, unknown> }
  }
  return null
}

function parseDirectiveObject(parsed: Record<string, unknown>): ToolCallDirective | ToolBatchDirective | FinalDirective | null {
  if (parsed.mode === "tool" && typeof parsed.tool === "string" && parsed.input && typeof parsed.input === "object") {
    return { mode: "tool", tool: parsed.tool, input: parsed.input as Record<string, unknown> }
  }
  if (typeof parsed.tool === "string" && parsed.input && typeof parsed.input === "object" && !Array.isArray(parsed.input)) {
    return { mode: "tool", tool: parsed.tool, input: parsed.input as Record<string, unknown> }
  }
  if (parsed.mode === "tools" && Array.isArray(parsed.tools)) {
    const tools = parsed.tools.map(normalizeToolEntry).filter((tool): tool is ToolCallDirective => tool !== null)
    if (tools.length > 0) return { mode: "tools", tools }
  }
  if (parsed.mode === "final" && typeof parsed.message === "string") {
    return { mode: "final", message: parsed.message }
  }
  if (typeof parsed.command === "string" && parsed.command.trim().length > 0) {
    return { mode: "tool", tool: "Bash", input: { command: parsed.command } }
  }
  return null
}

function parseEmbeddedJsonDirective(text: string): ToolCallDirective | ToolBatchDirective | FinalDirective | null {
  const starts: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") starts.push(index)
  }

  for (const start of starts) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]!
      if (inString) {
        if (escaped) {
          escaped = false
          continue
        }
        if (char === "\\") {
          escaped = true
          continue
        }
        if (char === "\"") {
          inString = false
        }
        continue
      }
      if (char === "\"") {
        inString = true
        continue
      }
      if (char === "{") {
        depth += 1
        continue
      }
      if (char === "}") {
        depth -= 1
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, index + 1)) as Record<string, unknown>
            const directive = parseDirectiveObject(parsed)
            if (directive) return directive
          } catch {}
          break
        }
      }
    }
  }
  return null
}

export function parseDirective(text: string): ToolCallDirective | ToolBatchDirective | FinalDirective | null {
  const raw = text.trim()
  return (
    parseMinimaxToolCall(raw) ||
    parseBracketToolCall(raw) ||
    parseEmbeddedJsonDirective(raw) ||
    [
      raw,
      normalizeDirectiveCandidate(raw),
      raw.match(/```json\s*([\s\S]*?)```/i)?.[1],
      raw.match(/```([\s\S]*?)```/)?.[1],
      raw.match(/\{[\s\S]*\}/)?.[0],
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map(normalizeDirectiveCandidate)
      .map(candidate => {
        try {
          return parseDirectiveObject(JSON.parse(candidate) as Record<string, unknown>)
        } catch {
          return null
        }
      })
      .find(Boolean) ||
    null
  )
}
