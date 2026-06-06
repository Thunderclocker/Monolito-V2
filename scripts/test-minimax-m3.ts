/**
 * Quick end-to-end test: bootstrap config, run a single turn with MiniMax M3,
 * print the result. Used to verify the API key works against the actual
 * Monolito agent (not just curl).
 */

import { MonolitoV2Runtime } from "../src/core/runtime/runtime.ts"
import { bootstrapConfigFromEnv, readModelSettings } from "../src/core/runtime/modelConfig.ts"
import { ensureDirs } from "../src/core/ipc/protocol.ts"
import { ensureSession } from "../src/core/session/store.ts"

const ROOT = "/tmp/monolito-m3-test"

const env: NodeJS.ProcessEnv = {
  ...process.env,
  MONOLITO_ROOT: ROOT,
  ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
  ANTHROPIC_AUTH_TOKEN: process.env.PROVIDER_API_KEY ?? "",
  ANTHROPIC_MODEL: "MiniMax-M3",
  MONOLITO_ACTIVE_PROVIDER: "minimax",
}

await ensureDirs(ROOT)
await bootstrapConfigFromEnv(env)
const settings = readModelSettings()
console.log("[test] Persisted settings:")
console.log("  baseUrl:", settings.env.ANTHROPIC_BASE_URL)
console.log("  model:", settings.env.ANTHROPIC_MODEL)
console.log("  token length:", (settings.env.ANTHROPIC_AUTH_TOKEN ?? "").length)

const sessionId = "test-m3-" + Date.now()
const userPrompt = "Reply with exactly: PONG. Nothing else."

// IMPORTANT: create the session row first so appendWorklog's FOREIGN KEY
// constraint doesn't fail later inside runTurn.
ensureSession(ROOT, sessionId, "MiniMax M3 test session")
console.log(`[test] Session created: ${sessionId}`)

const runtime = new MonolitoV2Runtime(ROOT)
console.log(`[test] Sending prompt to agent: "${userPrompt}"`)

try {
  // runTurn returns AssistantTurnResult, not an async iterable
  const result = await runtime.runTurn(sessionId, userPrompt, "default", {
    cwd: ROOT,
    maxTokens: 200,
  })
  console.log(`[test] Final response: ${JSON.stringify((result as { finalText?: string }).finalText ?? "(no finalText)").slice(0, 300)}`)
  if ("usage" in result) {
    console.log(`[test] Usage:`, JSON.stringify((result as { usage?: unknown }).usage))
  }
  if ("error" in result && (result as { error?: string }).error) {
    console.error(`[test] Error:`, (result as { error?: string }).error)
  }
} catch (e) {
  console.error("[test] Caught error:", e instanceof Error ? e.message : String(e))
  console.error("[test] Stack:", e instanceof Error ? e.stack?.split("\n").slice(0, 5).join("\n") : "(no stack)")
}
