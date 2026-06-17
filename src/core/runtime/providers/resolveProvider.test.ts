import assert from "node:assert/strict"
import test from "node:test"
import { isLocalOllamaAnthropicBackend, isOllamaLocalBaseUrl, resolveChatProviderConfig } from "./resolveProvider.ts"

test("isOllamaLocalBaseUrl detects localhost Ollama", () => {
  assert.equal(isOllamaLocalBaseUrl("http://localhost:11434"), true)
  assert.equal(isOllamaLocalBaseUrl("http://127.0.0.1:11434/v1"), true)
  assert.equal(isOllamaLocalBaseUrl("https://api.anthropic.com"), false)
})

test("resolveChatProviderConfig leaves native ollama profiles unchanged", () => {
  const input = {
    provider: "ollama" as const,
    baseUrl: "http://localhost:11434",
    apiKey: "",
    model: "gpt-oss:20b",
  }
  assert.deepEqual(resolveChatProviderConfig(input), input)
})

test("resolveChatProviderConfig leaves non-ollama providers unchanged", () => {
  const input = {
    provider: "anthropic_compatible" as const,
    baseUrl: "https://api.minimax.io/anthropic",
    apiKey: "sk-test",
    model: "MiniMax-M2.5",
  }
  assert.deepEqual(resolveChatProviderConfig(input), input)
})

test("resolveChatProviderConfig routes openai_compatible on localhost through anthropic", () => {
  const resolved = resolveChatProviderConfig({
    provider: "openai_compatible",
    baseUrl: "http://127.0.0.1:11434",
    apiKey: "",
    model: "gpt-oss:20b",
  })
  assert.equal(resolved.provider, "anthropic_compatible")
})

test("isLocalOllamaAnthropicBackend", () => {
  assert.equal(isLocalOllamaAnthropicBackend({
    provider: "anthropic_compatible",
    baseUrl: "http://localhost:11434",
    apiKey: "ollama",
    model: "gpt-oss:20b",
  }), true)
  assert.equal(isLocalOllamaAnthropicBackend({
    provider: "anthropic_compatible",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-test",
    model: "claude-sonnet-4-20250514",
  }), false)
})
