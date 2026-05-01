import type { AgentEvent, SessionRecord, SessionSummary } from "../../core/ipc/protocol.ts"
import { formatSessionRow, ToolUseRenderer } from "../../core/renderer/toolRenderer.ts"
import { DaemonClient } from "../../core/client/daemonClient.ts"
import type { CliArgs } from "./args.ts"
import { formatHistory, writeBlock, writeLine } from "./output.ts"
import { openInteractiveSession, runOneShot, ensureCliSession, waitForTurnCompletion } from "./session.ts"
import { stdout } from "node:process"

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
    writeLine("  /command        Run daemon command directly: /help /update /reset /model /channels")
    return
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
