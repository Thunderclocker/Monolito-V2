import type { ProviderConfig } from "./types.ts"

/** True when baseUrl points at a local Ollama daemon (default port). */
export function isOllamaLocalBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.trim().toLowerCase().replace(/\/+$/, "")
  return normalized.includes("localhost:11434")
    || normalized.includes("127.0.0.1:11434")
    || normalized.includes("[::1]:11434")
}

/**
 * Claude Code uses ANTHROPIC_BASE_URL → /v1/messages for local models.
 * Monolito resolves any local-Ollama profile to the same Anthropic Messages
 * protocol so tool_use blocks work (gpt-oss, qwen, etc.).
 */
export function resolveChatProviderConfig(config: ProviderConfig): ProviderConfig {
  const localOllama = isOllamaLocalBaseUrl(config.baseUrl)
  const useAnthropicMessages = config.provider === "ollama"
    || (localOllama && config.provider === "openai_compatible")

  if (!useAnthropicMessages) return config

  return {
    ...config,
    provider: "anthropic_compatible",
    apiKey: config.apiKey.trim() || "ollama",
  }
}

export function isLocalOllamaAnthropicBackend(config: ProviderConfig): boolean {
  return isOllamaLocalBaseUrl(config.baseUrl)
    && (config.provider === "anthropic_compatible" || config.provider === "ollama")
}
