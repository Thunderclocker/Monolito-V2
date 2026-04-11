function stripCodeFences(raw: string) {
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1]!.trim() : raw
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = stripCodeFences(raw.trim())
  if (!trimmed) return {}

  const candidates = [trimmed]
  const objectSlice = trimmed.match(/\{[\s\S]*\}/)?.[0]
  if (objectSlice && objectSlice !== trimmed) candidates.push(objectSlice)
  const balancedObjects = extractBalancedJsonObjects(trimmed)
  for (const candidate of balancedObjects) {
    if (!candidates.includes(candidate)) candidates.push(candidate)
  }

  for (const candidate of candidates) {
    let current: unknown = candidate
    for (let depth = 0; depth < 2; depth += 1) {
      if (typeof current !== "string") break
      try {
        current = JSON.parse(current)
      } catch {
        current = null
        break
      }
    }
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return current as Record<string, unknown>
    }
  }

  return null
}

function extractBalancedJsonObjects(raw: string) {
  const matches: string[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let start = -1

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === "\"") {
        inString = false
      }
      continue
    }
    if (char === "\"") {
      inString = true
      continue
    }
    if (char === "{") {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === "}") {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        matches.push(raw.slice(start, index + 1))
        start = -1
      }
    }
  }

  return matches.reverse()
}

export function normalizeToolInputPayload(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== "_raw" || typeof record._raw !== "string") return input

  const parsed = tryParseJsonObject(record._raw)
  if (!parsed) return input
  return normalizeToolInputPayload(parsed)
}
