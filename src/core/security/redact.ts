const REDACTED = "[REDACTED]"

const SENSITIVE_KEY_PATTERN = /(^|[_-])(token|api[_-]?key|authorization|password|secret|credential)([_-]|$)|^(apiKey|authToken|accessToken|refreshToken|botToken|clientSecret|privateKey|sessionToken)$/i
const TELEGRAM_BOT_TOKEN_PATTERN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi
const GENERIC_API_KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,})\b/g
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g
/** Brave Search subscription tokens (typically start with BSA). */
const BRAVE_SEARCH_KEY_PATTERN = /\bBSA[A-Za-z0-9_-]{18,}\b/g
/** Tavily hosted search keys. */
const TAVILY_KEY_PATTERN = /\btvly-[A-Za-z0-9_-]{10,}\b/gi

export function redactSensitiveText(value: string) {
  return value
    .replace(PRIVATE_KEY_PATTERN, REDACTED)
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED}`)
    .replace(TELEGRAM_BOT_TOKEN_PATTERN, REDACTED)
    .replace(GENERIC_API_KEY_PATTERN, REDACTED)
    .replace(BRAVE_SEARCH_KEY_PATTERN, REDACTED)
    .replace(TAVILY_KEY_PATTERN, REDACTED)
}

export function redactSensitiveValue<T>(value: T): T {
  return redactSensitiveValueInternal(value, new WeakMap<object, unknown>())
}

function redactSensitiveValueInternal<T>(value: T, seen: WeakMap<object, unknown>): T {
  if (typeof value === "string") return redactSensitiveText(value) as T
  if (!value || typeof value !== "object") return value

  const existing = seen.get(value as object)
  if (existing) return existing as T

  if (Array.isArray(value)) {
    const redacted: unknown[] = []
    seen.set(value, redacted)
    for (const item of value) redacted.push(redactSensitiveValueInternal(item, seen))
    return redacted as T
  }

  const redacted: Record<string, unknown> = {}
  seen.set(value as object, redacted)
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED
      : redactSensitiveValueInternal(item, seen)
  }
  return redacted as T
}
