const REDACTED = "[REDACTED]"

const SENSITIVE_KEY_PATTERN = /(^|_)(token|api[_-]?key|authorization|password|secret|credential)(_|$)/i
const TELEGRAM_BOT_TOKEN_PATTERN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi
const GENERIC_API_KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,})\b/g

export function redactSensitiveText(value: string) {
  return value
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED}`)
    .replace(TELEGRAM_BOT_TOKEN_PATTERN, REDACTED)
    .replace(GENERIC_API_KEY_PATTERN, REDACTED)
}

export function redactSensitiveValue<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(item => redactSensitiveValue(item)) as T

  const redacted: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED
      : redactSensitiveValue(item)
  }
  return redacted as T
}
