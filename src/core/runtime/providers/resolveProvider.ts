import type { ProviderConfig } from "./types.ts"

/** True when baseUrl points at a local Ollama daemon (default port). */
export function isOllamaLocalBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.trim().toLowerCase().replace(/\/+$/, "")
  return normalized.includes("localhost:11434")
    || normalized.includes("127.0.0.1:11434")
    || normalized.includes("[::1]:11434")
}

/**
 * Local OpenAI-compatible profiles on Ollama still use the Anthropic Messages shim.
 * Native `ollama` profiles use /api/chat directly (see providers/index.ts).
 */
export function resolveChatProviderConfig(config: ProviderConfig): ProviderConfig {
  const localOllama = isOllamaLocalBaseUrl(config.baseUrl)
  const useAnthropicMessages = localOllama && config.provider === "openai_compatible"

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
