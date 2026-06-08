// Bash semantic permission classifier (Haiku-style).
// upstream parity: extraído de claude-code upstream. Usa un LLM chico
// para evaluar semantic rules (no globs simples).
//
// Feature flag: MONOLITO_BASH_SEMANTIC_PERMISSIONS=1
// Por default off. Cuando se activa, las rules con formato
// "Bash(downloads-and-executes-remote-code:*)" se evalúan via LLM.

import { LruCache } from "../../../utils/lru-cache.ts"

export const CACHE_TTL_MS = 60 * 60 * 1000  // 1h
export const DEFAULT_BUDGET_TOKENS = 1  // yes/no answer

export type SemanticDecision = "yes" | "no" | "unsure"

export type SemanticRule = {
  /** Human-readable description of the pattern */
  description: string
  /** Unique cache key (e.g. "downloads-remote-code") */
  id: string
}

export type SemanticCacheKey = string  // hash(rule.id + command)

let _cache: LruCache<SemanticCacheKey, SemanticDecision> | null = null

function getCache(): LruCache<SemanticCacheKey, SemanticDecision> {
  if (!_cache) {
    _cache = new LruCache<SemanticCacheKey, SemanticDecision>({
      maxEntries: 1000,
      ttlMs: CACHE_TTL_MS,
    })
  }
  return _cache
}

/** Hash a string to a stable cache key. */
export function hashKey(s: string): string {
  // Simple djb2-like hash for cache key (no crypto needed)
  let hash = 5381
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

/** Decide si un comando matches una semantic rule via LLM.
 *  Default implementation returns "unsure" (deny-by-default). */
export async function semanticMatch(
  rule: SemanticRule,
  command: string,
  classifier: (prompt: string) => Promise<string> = defaultClassifier,
): Promise<SemanticDecision> {
  const cacheKey = hashKey(`${rule.id}:${command}`)
  const cached = getCache().get(cacheKey)
  if (cached) return cached

  const prompt = `You are a security classifier. Answer ONLY "yes" or "no".

Rule: ${rule.description}
Command: ${command}

Does the command match the rule? Answer yes or no:`

  try {
    const response = await classifier(prompt)
    const decision = parseResponse(response)
    getCache().set(cacheKey, decision)
    return decision
  } catch {
    return "unsure"
  }
}

export function parseResponse(raw: string): SemanticDecision {
  const lower = raw.toLowerCase().trim()
  if (lower.startsWith("yes") || lower === "y" || lower.includes("yes,") || lower.includes("yes.")) return "yes"
  if (lower.startsWith("no") || lower === "n" || lower.includes("no,") || lower.includes("no.")) return "no"
  return "unsure"
}

/** Default classifier stub. Returns "unsure" (deny-by-default). */
async function defaultClassifier(prompt: string): Promise<string> {
  return "unsure"
}

/** Anthropic Claude Haiku classifier (real). Requires ANTHROPIC_API_KEY. */
export async function anthropicHaikuClassifier(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set")
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 1,
      messages: [{ role: "user", content: prompt }],
    }),
  })
  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`)
  }
  const data = await response.json() as { content?: Array<{ text?: string }> }
  return data.content?.[0]?.text ?? "unsure"
}

/** Ollama local classifier (Qwen2.5-1.5B-Instruct o similar). Requires Ollama running. */
export async function ollamaClassifier(prompt: string, model: string = "qwen2.5:1.5b"): Promise<string> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
    }),
  })
  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status}`)
  }
  const data = await response.json() as { response?: string }
  return data.response ?? "unsure"
}

/** Check feature flag. */
export function isSemanticClassifierEnabled(): boolean {
  return process.env.MONOLITO_BASH_SEMANTIC_PERMISSIONS === "1"
}

/** Clear the cache. */
export function clearSemanticCache(): void {
  if (_cache) _cache.clear()
}
