function tryParseNestedJson(value: string): unknown {
  let current: unknown = value.trim()
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof current !== "string") break
    try {
      current = JSON.parse(current)
    } catch {
      return null
    }
  }
  return current
}

export function coerceConfigRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== "string") return null
  const parsed = tryParseNestedJson(value)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null
}
