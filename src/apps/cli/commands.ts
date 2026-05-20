import type { AgentEvent, SessionRecord, SessionSummary } from "../../core/ipc/protocol.ts"
import { formatSessionRow, ToolUseRenderer } from "../../core/renderer/toolRenderer.ts"
import { DaemonClient } from "../../core/client/daemonClient.ts"
import type { CliArgs } from "./args.ts"
import { formatHistory, writeBlock, writeLine } from "./output.ts"
import { openInteractiveSession, runOneShot, ensureCliSession, waitForTurnCompletion } from "./session.ts"
import { stdout } from "node:process"
import { renderFormattedBlock } from "./tui/formatters.ts"
import { exec } from "node:child_process"
import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import {
  discoverXaiEndpoints,
  generatePkce,
  listenForAuthCode,
  exchangeCodeForTokens,
  getGrokTokensPath,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_SCOPE,
  XAI_OAUTH_REDIRECT_URI,
} from "../../core/runtime/providers/grokAuth.ts"
import { addProfile, listProfiles } from "../../core/runtime/modelRegistry.ts"

function renderEventLog(events: AgentEvent[]) {
  const renderer = new ToolUseRenderer()
  return events.map(event => renderer.render(event)).filter(Boolean).join("\n")
}

function parseHistoryLimit(raw?: string) {
  return raw ? Number.parseInt(raw, 10) : 20
}

export async function runCliCommand(client: DaemonClient, args: CliArgs) {
  const { command, rest, prompt } = args

  if (command === "--help") {
    writeLine("monolito [sessions|resume <id>|logs <id>|status <id>|history <id>|ask <prompt>|/command [args]] [-p <prompt>]")
    writeLine("Without arguments, opens the Monolito terminal client and starts the daemon if needed.")
    writeLine("  ask <prompt>    Send a prompt to Monolito via Unix socket (no TUI)")
    writeLine("  /command        Run daemon command directly: /help /status /update /reset /model /channels")
    writeLine("  auth xai-oauth  Log in via your Grok / X Premium+ account using browser OAuth")
    return
  }

  if (command === "auth") {
    const sub = rest[0]
    if (sub === "xai-oauth") {
      writeLine("\n\x1b[1m\x1b[36m◆ Starting xAI Grok Browser Authentication...\x1b[0m")
      
      const state = randomBytes(16).toString("hex")
      const nonce = randomBytes(16).toString("hex")
      
      writeLine("Discovering xAI endpoints...")
      const { authorization_endpoint } = await discoverXaiEndpoints()
      
      writeLine("Generating secure PKCE code verifier and challenge...")
      const { codeVerifier, codeChallenge } = generatePkce()
      
      const authUrl = new URL(authorization_endpoint)
      authUrl.searchParams.set("response_type", "code")
      authUrl.searchParams.set("client_id", XAI_OAUTH_CLIENT_ID)
      authUrl.searchParams.set("redirect_uri", XAI_OAUTH_REDIRECT_URI)
      authUrl.searchParams.set("scope", XAI_OAUTH_SCOPE)
      authUrl.searchParams.set("code_challenge", codeChallenge)
      authUrl.searchParams.set("code_challenge_method", "S256")
      authUrl.searchParams.set("state", state)
      authUrl.searchParams.set("nonce", nonce)
      authUrl.searchParams.set("plan", "generic")
      authUrl.searchParams.set("referrer", "monolito")
      
      writeLine("\n\x1b[1m\x1b[32m✔ Local callback server running on port 56121\x1b[0m")
      writeLine("\x1b[1mPlease visit the following URL to log in via your X (Grok) account:\x1b[0m")
      writeLine(`\n  \x1b[4m\x1b[34m${authUrl.toString()}\x1b[0m\n`)
      
      // Attempt to automatically open the default browser
      const openCmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open"
      exec(`${openCmd} "${authUrl.toString().replace(/"/g, '\\"')}"`, () => {})
      
      writeLine("Waiting for browser callback. Click the link above if it didn't open automatically...")
      
      try {
        const { code } = await listenForAuthCode(state)
        writeLine("\nExchanging authorization code for OAuth tokens...")
        const tokens = await exchangeCodeForTokens(code, codeVerifier, codeChallenge)
        
        // Save the tokens
        const tokensPath = getGrokTokensPath()
        writeFileSync(tokensPath, JSON.stringify(tokens, null, 2))
        writeLine(`\x1b[1m\x1b[32m✔ Authentication successful! Tokens saved to:\x1b[0m ${tokensPath}`)
        
        // Register or update profile
        const profiles = listProfiles()
        const oauthProfile = profiles.find(p => p.provider === "xai-oauth")
        if (oauthProfile) {
          writeLine(`Profile "${oauthProfile.name}" is already configured for Grok OAuth.`)
        } else {
          writeLine("Creating a new model profile for Grok OAuth...")
          const newProfile = addProfile({
            name: "Grok OAuth",
            provider: "xai-oauth",
            model: "grok-2-1212",
            baseUrl: "https://api.x.ai",
            apiKey: "oauth",
          })
          writeLine(`\x1b[1m\x1b[32m✔ Profile "${newProfile.name}" registered and activated successfully!\x1b[0m`)
        }
      } catch (err) {
        writeLine(`\n\x1b[1m\x1b[31m✖ Authentication failed:\x1b[0m ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    } else {
      writeLine("Usage: monolito auth xai-oauth")
      return
    }
  }

  if (command === "sessions") {
    const sessions = (await client.listSessions()) as SessionSummary[]
    writeLine(sessions.map(formatSessionRow).join("\n"))
    return
  }

  if (command === "logs") {
    const sessionId = rest[0]
    if (!sessionId) throw new Error("logs requires a session id")
    const events = (await client.tailEvents(sessionId)) as AgentEvent[]
    writeBlock(renderEventLog(events))
    return
  }

  if (command === "status") {
    const sessionId = rest[0]
    if (!sessionId) throw new Error("status requires a session id")
    const session = (await client.getSession(sessionId)) as SessionRecord | null
    writeBlock(JSON.stringify(session, null, 2))
    return
  }

  if (command === "history") {
    const sessionId = rest[0]
    if (!sessionId) throw new Error("history requires a session id")
    const session = (await client.getSession(sessionId)) as SessionRecord | null
    if (!session) throw new Error(`Session ${sessionId} not found`)
    writeLine(formatHistory(session, parseHistoryLimit(rest[1])))
    return
  }

  if (command === "resume") {
    const sessionId = rest[0]
    if (!sessionId) throw new Error("resume requires a session id")
    if (prompt) {
      await runOneShot(client, prompt, sessionId)
      return
    }
    await openInteractiveSession(client, sessionId)
    return
  }

  if (command === "ask") {
    const text = (rest.join(" ") || prompt || "").trim()
    if (!text) {
      writeLine("Usage: monolito ask \"your prompt here\"")
      return
    }
    const renderer = new ToolUseRenderer()
    const session = await ensureCliSession(client, undefined)
    await client.subscribe(session.id)
    const unsubscribe = client.onEvent((event: AgentEvent) => {
      if (event.sessionId !== session.id) return
      const line = renderer.render(event)
      if (line) stdout.write(`${line}\n`)
    })
    const completion = waitForTurnCompletion(client, session.id)
    await client.sendMessage(session.id, text)
    await completion
    unsubscribe()
    return
  }

  if (command?.startsWith("/")) {
    const output = await client.runDaemonCommand(command)
    writeLine(output)
    return
  }

  if (prompt) {
    await runOneShot(client, prompt)
    return
  }

  if (command) {
    await runOneShot(client, [command, ...rest].join(" "))
    return
  }

  await openInteractiveSession(client)
}
