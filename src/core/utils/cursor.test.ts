// Tests para cursor.ts (file storage)

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import {
  getCursor,
  advanceCursor,
  incrementCounters,
  resetCursor,
  listCursors,
  _resetSchemaCacheForTests,
  type CursorStorage,
} from "./cursor.ts"
import { processingCursorsPath } from "../storage/filePaths.ts"

function freshStorage(): CursorStorage {
  _resetSchemaCacheForTests()
  const rootDir = mkdtempSync(join(tmpdir(), "cursor-test-"))
  process.env.MONOLITO_ROOT = rootDir
  return { kind: "files", rootDir }
}

test("cursor: getCursor returns zero state for unknown streamId", () => {
  const storage = freshStorage()
  const state = getCursor(storage, "stream:1")
  assert.equal(state.streamId, "stream:1")
  assert.equal(state.position, 0)
  assert.equal(state.lastProcessedAt, null)
  assert.equal(state.totalProcessed, 0)
  assert.equal(state.totalErrors, 0)
  assert.deepEqual(state.meta, {})
  rmSync(storage.rootDir, { recursive: true, force: true })
})

test("cursor: advanceCursor is upsert + atomic", () => {
  const storage = freshStorage()
  const a = advanceCursor(storage, "stream:1", 5, { drawerId: "abc" })
  assert.equal(a.position, 5)
  assert.equal(a.meta.drawerId, "abc")

  const b = advanceCursor(storage, "stream:1", 10)
  assert.equal(b.position, 10)
  assert.equal(b.meta.drawerId, "abc")

  const c = advanceCursor(storage, "stream:1", 15, { drawerId: "xyz", drawerCount: 42 })
  assert.equal(c.position, 15)
  assert.equal(c.meta.drawerId, "xyz")
  assert.equal(c.meta.drawerCount, 42)
  rmSync(storage.rootDir, { recursive: true, force: true })
})

test("cursor: advanceCursor is monotonic (rejects backward movement)", () => {
  const storage = freshStorage()
  advanceCursor(storage, "stream:1", 100)
  const after = advanceCursor(storage, "stream:1", 50)
  assert.equal(after.position, 100, "position must not move backward")
  rmSync(storage.rootDir, { recursive: true, force: true })
})

test("cursor: resetCursor clears state but keeps the row", () => {
  const storage = freshStorage()
  advanceCursor(storage, "stream:1", 100, { x: 1 })
  incrementCounters(storage, "stream:1", "processed")
  incrementCounters(storage, "stream:1", "errors")

  const after = resetCursor(storage, "stream:1")
  assert.equal(after.position, 0)
  assert.equal(after.totalProcessed, 0)
  assert.equal(after.totalErrors, 0)
  assert.deepEqual(after.meta, {})
  rmSync(storage.rootDir, { recursive: true, force: true })
})

test("cursor: incrementCounters updates the right counter", () => {
  const storage = freshStorage()
  advanceCursor(storage, "stream:1", 1)
  incrementCounters(storage, "stream:1", "processed")
  incrementCounters(storage, "stream:1", "processed")
  incrementCounters(storage, "stream:1", "errors")

  const state = getCursor(storage, "stream:1")
  assert.equal(state.totalProcessed, 2)
  assert.equal(state.totalErrors, 1)
  assert.ok(state.lastProcessedAt, "lastProcessedAt should be set")
  rmSync(storage.rootDir, { recursive: true, force: true })
})

test("cursor: listCursors returns all streams sorted by recency", () => {
  const storage = freshStorage()
  advanceCursor(storage, "stream:a", 1, undefined, "2026-06-08T10:00:00Z")
  advanceCursor(storage, "stream:b", 1, undefined, "2026-06-08T11:00:00Z")
  advanceCursor(storage, "stream:c", 1, undefined, "2026-06-08T09:00:00Z")

  const all = listCursors(storage)
  assert.equal(all.length, 3)
  assert.equal(all[0]?.streamId, "stream:b")
  assert.equal(all[1]?.streamId, "stream:a")
  assert.equal(all[2]?.streamId, "stream:c")
  rmSync(storage.rootDir, { recursive: true, force: true })
})

test("cursor: meta persists JSON-safe values across reads", () => {
  const storage = freshStorage()
  advanceCursor(storage, "stream:1", 1, { items: [1, 2, 3], nested: { ok: true }, str: "hello" })
  const state = getCursor(storage, "stream:1")
  assert.deepEqual(state.meta, { items: [1, 2, 3], nested: { ok: true }, str: "hello" })
  rmSync(storage.rootDir, { recursive: true, force: true })
})

test("cursor: corrupt file is tolerated (returns empty)", () => {
  const storage = freshStorage()
  const path = processingCursorsPath(storage.rootDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "{not valid json", "utf8")
  const state = getCursor(storage, "stream:bad")
  assert.equal(state.position, 0)
  rmSync(storage.rootDir, { recursive: true, force: true })
})
