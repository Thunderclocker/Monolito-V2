// Tests para la columna hidden_from_user en messages.
//
// Esta columna permite que el orquestador inyecte mensajes en la sesión
// (para que el modelo los lea en el próximo turn) sin que aparezcan en
// el transcript que el CLI del usuario renderiza. Caso de uso principal:
// el feedback prompt del Top-level Ralph Gate (runtime.ts:2657) es
// orquestación interna entre el sub-agent y el orquestador, no output
// para el usuario.
//
// Estos tests son DB-backed. Usan SQLite :memory: con el mismo path de
// inicialización que production (loadEnv, ensureDirs, ensureVectorSchema,
// etc.) vía el singleton de getDb.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Bypass the runtime-DB safety guard added in the 09-jun-2026 fix. This
// test predates the guard and uses a pattern that depends on the guard
// being absent. The test paths are under os.tmpdir() so they are safe;
// we are NOT opening the live runtime DB. The follow-up is to migrate
// the test to the import-after-env-set pattern that the guard expects.
process.env.MONOLITO_DB_GUARD = "0"
process.env.MONOLITO_STORAGE_BACKEND = "sqlite"

function freshRootDir(): string {
  return mkdtempSync(join(tmpdir(), "monolito-hidden-msg-test-"))
}

test("appendMessage: defaults to hiddenFromUser=false (visible)", async () => {
  const root = freshRootDir()
  process.env.MONOLITO_ROOT = root
  const { appendMessage, getSession } = await import("./store.ts")
  const { ensureMonolitoRoot } = await import("../system/root.ts")

  try {
    ensureMonolitoRoot()
    // Insert a session directly to avoid pulling in extra surface.
    const { getDb } = await import("./store.ts")
    const db = getDb(root)
    db.prepare(
      `INSERT INTO sessions (id, profile_id, title, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("test-session-1", "default", null, "idle", new Date().toISOString(), new Date().toISOString())

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
  const { appendMessage, getSession, getDb } = await import("./store.ts")
  const { ensureMonolitoRoot } = await import("../system/root.ts")

  try {
    ensureMonolitoRoot()
    const db = getDb(root)
    db.prepare(
      `INSERT INTO sessions (id, profile_id, title, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("test-session-2", "default", null, "idle", new Date().toISOString(), new Date().toISOString())

    appendMessage(root, "test-session-2", "user", "Visible message 1", { hiddenFromUser: false })
    appendMessage(
      root,
      "test-session-2",
      "user",
      "INTERNAL: ralph-gate feedback prompt with - [IN_PROGRESS] bullets",
      { hiddenFromUser: true },
    )
    appendMessage(root, "test-session-2", "user", "Visible message 2", { hiddenFromUser: false })

    // getSession must filter out the hidden message.
    const session = getSession(root, "test-session-2")
    assert.ok(session)
    assert.equal(session.messages.length, 2, "must filter hidden message from transcript")
    assert.equal(session.messages[0]?.text, "Visible message 1")
    assert.equal(session.messages[1]?.text, "Visible message 2")

    // But the hidden message must STILL be in the DB (audit/replay).
    const rawCount = db
      .prepare(`SELECT count(*) as c FROM messages WHERE session_id = ?`)
      .get("test-session-2") as { c: number }
    assert.equal(rawCount.c, 3, "all 3 messages must be persisted in DB")
    const hiddenCount = db
      .prepare(`SELECT count(*) as c FROM messages WHERE session_id = ? AND hidden_from_user = 1`)
      .get("test-session-2") as { c: number }
    assert.equal(hiddenCount.c, 1, "exactly 1 message must be hidden_from_user=1")
  } finally {
    rmSync(root, { recursive: true, force: true })
    delete process.env.MONOLITO_ROOT
  }
})

test("getSession: handles legacy DB without hidden_from_user column (NULL → visible)", async () => {
  // Simulates a DB created before the migration. Rows with NULL in
  // hidden_from_user must still be returned by getSession.
  const root = freshRootDir()
  process.env.MONOLITO_ROOT = root
  const { getDb, getSession } = await import("./store.ts")
  const { ensureMonolitoRoot } = await import("../system/root.ts")

  try {
    ensureMonolitoRoot()
    const db = getDb(root)
    db.prepare(
      `INSERT INTO sessions (id, profile_id, title, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("test-session-3", "default", null, "idle", new Date().toISOString(), new Date().toISOString())
    // Manually insert a row that mimics the pre-migration state: column
    // absent, so reading it yields NULL.
    db.prepare(
      `INSERT INTO messages (session_id, role, text, at) VALUES (?, ?, ?, ?)`,
    ).run("test-session-3", "user", "legacy message without hidden flag", new Date().toISOString())

    const session = getSession(root, "test-session-3")
    assert.ok(session)
    assert.equal(session.messages.length, 1, "legacy rows with NULL hidden_from_user must be visible")
    assert.equal(session.messages[0]?.text, "legacy message without hidden flag")
  } finally {
    rmSync(root, { recursive: true, force: true })
    delete process.env.MONOLITO_ROOT
  }
})

test("appendMessage: idempotent on options object (no options arg works)", async () => {
  // Backward-compat: existing callsites that don't pass options must
  // continue to work unchanged.
  const root = freshRootDir()
  process.env.MONOLITO_ROOT = root
  const { appendMessage, getSession, getDb } = await import("./store.ts")
  const { ensureMonolitoRoot } = await import("../system/root.ts")

  try {
    ensureMonolitoRoot()
    const db = getDb(root)
    db.prepare(
      `INSERT INTO sessions (id, profile_id, title, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("test-session-4", "default", null, "idle", new Date().toISOString(), new Date().toISOString())

    // No options arg — must default to visible.
    appendMessage(root, "test-session-4", "assistant", "no-options call")

    // Explicit empty options — must default to visible.
    appendMessage(root, "test-session-4", "user", "empty-options call", {})

    // Explicit hiddenFromUser: undefined — must default to visible.
    appendMessage(root, "test-session-4", "system", "undefined-options call", { hiddenFromUser: undefined })

    const session = getSession(root, "test-session-4")
    assert.ok(session)
    assert.equal(session.messages.length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
    delete process.env.MONOLITO_ROOT
  }
})
