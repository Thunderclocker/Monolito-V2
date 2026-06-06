/**
 * End-to-end smoke test: bootstrap config, run a turn with MiniMax M3.
 *
 * Used by:
 *   - Manual local testing (developer runs after a model change)
 *   - CI workflow (ci.yml smoke-test job)
 *
 * Exits 0 on success, 1 on any failure. Prints structured output so the
 * CI log shows what was tested.
 */

import { MonolitoV2Runtime } from "../src/core/runtime/runtime.ts"
import { bootstrapConfigFromEnv, readModelSettings } from "../src/core/runtime/modelConfig.ts"
import { ensureDirs } from "../src/core/ipc/protocol.ts"
import { ensureSession } from "../src/core/session/store.ts"
import { rmSync } from "node:fs"

const ROOT = process.env.MONOLITO_ROOT ?? "/tmp/monolito-smoke"
const TEST_PROMPT = "Reply with exactly: PONG. Nothing else."

function log(level: "info" | "error", msg: string) {
  const prefix = level === "error" ? "smoke-test: ERROR" : "smoke-test:"
  console.log(`[${prefix}] ${msg}`)
}

// Validate required env vars up front so we fail fast with a clear error.
const required = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"] as const
for (const key of required) {
  if (!process.env[key]) {
    log("error", `Missing required env var: ${key}`)
    process.exit(1)
  }
}

// Start from a clean slate so leftover state from a previous run doesn't
// pollute the test (e.g. cached embeddings, dangling sessions).
try {
  rmSync(ROOT, { recursive: true, force: true })
} catch {
  // best-effort cleanup
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
  MONOLITO_ROOT: ROOT,
  MONOLITO_ACTIVE_PROVIDER: process.env.MONOLITO_ACTIVE_PROVIDER ?? "minimax",
}

await ensureDirs(ROOT)
await bootstrapConfigFromEnv(env)
const settings = readModelSettings()
log("info", `baseUrl: ${settings.env.ANTHROPIC_BASE_URL}`)
log("info", `model:   ${settings.env.ANTHROPIC_MODEL}`)
log("info", `token length: ${(settings.env.ANTHROPIC_AUTH_TOKEN ?? "").length}`)

const sessionId = "smoke-" + Date.now()
ensureSession(ROOT, sessionId, "MiniMax M3 smoke test")
log("info", `session: ${sessionId}`)
log("info", `prompt:  "${TEST_PROMPT}"`)

const runtime = new MonolitoV2Runtime(ROOT)
const startedAt = Date.now()
try {
  const result = await runtime.runTurn(sessionId, TEST_PROMPT, "default", {
    cwd: ROOT,
    maxTokens: 200,
  })
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)
  const finalText = (result as { finalText?: string }).finalText
  if (!finalText) {
    log("error", "no finalText in response")
    process.exit(1)
  }
  log("info", `response: ${JSON.stringify(finalText.slice(0, 200))}`)
  log("info", `elapsed:  ${elapsed}s`)
  if ("usage" in result) {
    log("info", `usage:    ${JSON.stringify((result as { usage?: unknown }).usage)}`)
  }
  // Sanity check: the response should contain "PONG" (case-insensitive).
  if (!/pong/i.test(finalText)) {
    log("error", `expected "PONG" in response, got: ${finalText}`)
    process.exit(1)
  }
  log("info", "PASS")
  process.exit(0)
} catch (e) {
  log("error", e instanceof Error ? e.message : String(e))
  if (e instanceof Error && e.stack) {
    log("error", e.stack.split("\n").slice(0, 3).join("\n"))
  }
  process.exit(1)
}
