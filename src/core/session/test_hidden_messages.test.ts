// Tests for hidden_from_user on session messages (file storage).

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function freshRootDir(): string {
  return mkdtempSync(join(tmpdir(), "monolito-hidden-msg-test-"))
}

test("appendMessage: defaults to hiddenFromUser=false (visible)", async () => {
  const root = freshRootDir()
  process.env.MONOLITO_ROOT = root
  const { appendMessage, getSession, createSession } = await import("./store.ts")

  try {
    createSession(root, "test", "test-session-1")
    appendMessage(root, "test-session-1", "user", "Hello visible world")
    const session = getSession(root, "test-session-1")
    assert.ok(session, "session must be retrievable")
    assert.equal(session.messages.length, 1)
    assert.equal(session.messages[0]?.text, "Hello visible world")
    assert.equal(session.messages[0]?.role, "user")
  } finally {
    rmSync(root, { recursive: true, force: true })
    delete process.env.MONOLITO_ROOT
  }
})

test("appendMessage: hiddenFromUser=true persists but is filtered from getSession", async () => {
  const root = freshRootDir()
  process.env.MONOLITO_ROOT = root
  const { appendMessage, getSession, createSession, getRawMessagesForSession } = await import("./store.ts")

  try {
    createSession(root, "test", "test-session-2")
    appendMessage(root, "test-session-2", "user", "Visible message 1", { hiddenFromUser: false })
    appendMessage(
      root,
      "test-session-2",
      "user",
      "INTERNAL: ralph-gate feedback prompt with - [IN_PROGRESS] bullets",
      { hiddenFromUser: true },
    )
    appendMessage(root, "test-session-2", "user", "Visible message 2", { hiddenFromUser: false })

    const session = getSession(root, "test-session-2")
    assert.ok(session)
    assert.equal(session.messages.length, 2, "must filter hidden message from transcript")
    assert.equal(session.messages[0]?.text, "Visible message 1")
    assert.equal(session.messages[1]?.text, "Visible message 2")

    const raw = getRawMessagesForSession(root, "test-session-2")
    assert.equal(raw.length, 3, "all 3 messages must be persisted")
  } finally {
    rmSync(root, { recursive: true, force: true })
    delete process.env.MONOLITO_ROOT
  }
})

test("appendMessage: idempotent on options object (no options arg works)", async () => {
  const root = freshRootDir()
  process.env.MONOLITO_ROOT = root
  const { appendMessage, getSession, createSession } = await import("./store.ts")

  try {
    createSession(root, "test", "test-session-4")
    appendMessage(root, "test-session-4", "assistant", "no-options call")
    appendMessage(root, "test-session-4", "user", "empty-options call", {})
    appendMessage(root, "test-session-4", "system", "undefined-options call", { hiddenFromUser: undefined })

    const session = getSession(root, "test-session-4")
    assert.ok(session)
    assert.equal(session.messages.length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
    delete process.env.MONOLITO_ROOT
  }
})
