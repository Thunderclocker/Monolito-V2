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

export function normalizeToolInputPayload(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== "_raw" || typeof record._raw !== "string") return input

  const parsed = tryParseJsonObject(record._raw)
  if (!parsed) return input
  return normalizeToolInputPayload(parsed)
}
