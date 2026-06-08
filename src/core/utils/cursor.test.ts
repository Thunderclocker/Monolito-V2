// Tests para cursor.ts

import test from "node:test"
import assert from "node:assert/strict"
import Database from "better-sqlite3"
import {
  bindCursorDb,
  getCursor,
  advanceCursor,
  incrementCounters,
  resetCursor,
  listCursors,
  _resetSchemaCacheForTests,
} from "./cursor.ts"

function freshDb(): Database.Database {
  _resetSchemaCacheForTests()
  const db = new Database(":memory:")
  bindCursorDb(db)
  return db
}

test("cursor: getCursor returns zero state for unknown streamId", () => {
  const db = freshDb()
  const state = getCursor(db, "stream:1")
  assert.equal(state.streamId, "stream:1")
  assert.equal(state.position, 0)
  assert.equal(state.lastProcessedAt, null)
  assert.equal(state.totalProcessed, 0)
  assert.equal(state.totalErrors, 0)
  assert.deepEqual(state.meta, {})
})

test("cursor: advanceCursor is upsert + atomic", () => {
  const db = freshDb()
  const a = advanceCursor(db, "stream:1", 5, { drawerId: "abc" })
  assert.equal(a.position, 5)
  assert.equal(a.meta.drawerId, "abc")

  const b = advanceCursor(db, "stream:1", 10)
  assert.equal(b.position, 10)
  // meta persists when not explicitly replaced
  assert.equal(b.meta.drawerId, "abc")

  const c = advanceCursor(db, "stream:1", 15, { drawerId: "xyz", drawerCount: 42 })
  assert.equal(c.position, 15)
  assert.equal(c.meta.drawerId, "xyz")
  assert.equal(c.meta.drawerCount, 42)
})

test("cursor: advanceCursor is monotonic (rejects backward movement)", () => {
  const db = freshDb()
  advanceCursor(db, "stream:1", 100)
  // Try to move backward — should be a no-op.
  const after = advanceCursor(db, "stream:1", 50)
  assert.equal(after.position, 100, "position must not move backward")
})

test("cursor: resetCursor clears state but keeps the row", () => {
  const db = freshDb()
  advanceCursor(db, "stream:1", 100, { x: 1 })
  incrementCounters(db, "stream:1", "processed")
  incrementCounters(db, "stream:1", "errors")

  const after = resetCursor(db, "stream:1")
  assert.equal(after.position, 0)
  assert.equal(after.totalProcessed, 0)
  assert.equal(after.totalErrors, 0)
  assert.deepEqual(after.meta, {})
})

test("cursor: incrementCounters updates the right counter", () => {
  const db = freshDb()
  advanceCursor(db, "stream:1", 1)
  incrementCounters(db, "stream:1", "processed")
  incrementCounters(db, "stream:1", "processed")
  incrementCounters(db, "stream:1", "errors")

  const state = getCursor(db, "stream:1")
  assert.equal(state.totalProcessed, 2)
  assert.equal(state.totalErrors, 1)
  assert.ok(state.lastProcessedAt, "lastProcessedAt should be set")
})

test("cursor: listCursors returns all streams sorted by recency", () => {
  const db = freshDb()
  advanceCursor(db, "stream:a", 1, undefined, "2026-06-08T10:00:00Z")
  advanceCursor(db, "stream:b", 1, undefined, "2026-06-08T11:00:00Z")
  advanceCursor(db, "stream:c", 1, undefined, "2026-06-08T09:00:00Z")

  const all = listCursors(db)
  assert.equal(all.length, 3)
  // Most recent first: b, a, c.
  assert.equal(all[0]?.streamId, "stream:b")
  assert.equal(all[1]?.streamId, "stream:a")
  assert.equal(all[2]?.streamId, "stream:c")
})

test("cursor: meta persists JSON-safe values across reads", () => {
  const db = freshDb()
  advanceCursor(db, "stream:1", 1, { items: [1, 2, 3], nested: { ok: true }, str: "hello" })
  const state = getCursor(db, "stream:1")
  assert.deepEqual(state.meta, { items: [1, 2, 3], nested: { ok: true }, str: "hello" })
})

test("cursor: corrupt meta is tolerated (logged warn, returned empty)", () => {
  const db = freshDb()
  // Inject a corrupt meta directly via SQL.
  db.prepare(
    `INSERT INTO processing_cursors (stream_id, position, meta) VALUES (?, 0, 'not-json')`,
  ).run("stream:bad")
  const state = getCursor(db, "stream:bad")
  assert.deepEqual(state.meta, {})
})
