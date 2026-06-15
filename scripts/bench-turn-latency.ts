#!/usr/bin/env node --experimental-strip-types
/**
 * Lightweight turn latency probe against a running daemon.
 *
 * Usage:
 *   node --experimental-strip-types scripts/bench-turn-latency.ts "hola"
 *
 * Reads TURN_PREP / FIRST_TOKEN notes from the session worklog after the ask completes.
 */

import { spawn } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const prompt = process.argv.slice(2).join(" ") || "Responde solo: ok"
const monolitoRoot = process.env.MONOLITO_ROOT ?? join(process.env.HOME ?? "", ".monolito")
const sessionId = "orchestrator"
const worklogPath = join(monolitoRoot, "memory", "sessions", sessionId, "worklog.jsonl")
const repoRoot = join(import.meta.dirname, "..")
const bin = join(repoRoot, "bin", "monolito.js")

function readRecentWorklogNotes(limit = 20): string[] {
  if (!existsSync(worklogPath)) return []
  const lines = readFileSync(worklogPath, "utf8").trim().split("\n").filter(Boolean)
  return lines.slice(-limit).flatMap(line => {
    try {
      const entry = JSON.parse(line) as { summary?: string }
      return entry.summary ? [entry.summary] : []
    } catch {
      return []
    }
  })
}

const startedAt = Date.now()
const child = spawn("node", ["--experimental-strip-types", bin, "ask", prompt], {
  stdio: "inherit",
  env: process.env,
})

child.on("close", code => {
  const totalMs = Date.now() - startedAt
  const notes = readRecentWorklogNotes()
  const turnPrep = notes.findLast(note => note.startsWith("TURN_PREP:"))
  const firstToken = notes.findLast(note => note.startsWith("FIRST_TOKEN:"))
  console.log("")
  console.log("=== bench-turn-latency ===")
  console.log(`prompt: ${JSON.stringify(prompt)}`)
  console.log(`exit: ${code ?? "unknown"}`)
  console.log(`total_ms: ${totalMs}`)
  console.log(`turn_prep: ${turnPrep ?? "(not logged)"}`)
  console.log(`first_token: ${firstToken ?? "(not logged)"}`)
  process.exit(code ?? 1)
})
