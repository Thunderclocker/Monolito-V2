import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolated environment root before importing Monolito core modules.
// Note: getPaths() builds stateDir from MONOLITO_ROOT, so all tests
// in this file share the same SQLite database. We isolate by
// truncating the telegram_sent_photos table in `before`.
const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-sent-photos-test-"))
process.env.MONOLITO_ROOT = testMonolitoRoot
process.env.MONOLITO_STORAGE_BACKEND = "sqlite"

const { getTool } = await import("../registry.ts")
const { getDb, writeConfigWing } = await import("../../session/store.ts")

after(() => {
  rmSync(testMonolitoRoot, { recursive: true, force: true })
})

before(async () => {
  writeConfigWing(testMonolitoRoot, "CONF_CHANNELS", {
    telegram: {
      token: "TEST-TOKEN-1234567890:ABCDEFG",
      enabled: true,
      allowedChats: [1515784684, 12345, 111, 222],
    },
  })
})

function clearSentPhotos() {
  const db = getDb(testMonolitoRoot)
  db.exec("DELETE FROM telegram_sent_photos")
}

interface SentPhotoRow {
  message_id: number
  file_id: string | null
  caption: string | null
  local_path: string | null
  chat_id: number
}

interface RecentPhotosResult {
  ok: boolean
  count: number
  photos: SentPhotoRow[]
}

test("TelegramGetRecentPhotos returns the most recent sent photos in DESC order", async () => {
  clearSentPhotos()
  const now = new Date()
  const minus = (sec: number) => new Date(now.getTime() - sec * 1000).toISOString().slice(0, 19).replace("T", " ")
  const db = getDb(testMonolitoRoot)
  const insert = db.prepare(`
    INSERT INTO telegram_sent_photos (chat_id, message_id, file_id, local_path, caption, sent_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  insert.run(1515784684, 100, "file_id_old", "/tmp/old.jpg", "old caption", minus(60))
  insert.run(1515784684, 101, "file_id_mid", "/tmp/mid.jpg", null, minus(30))
  insert.run(1515784684, 102, "file_id_new", "/tmp/new.jpg", "new caption", minus(5))

  const tool = getTool("TelegramGetRecentPhotos")
  assert.ok(tool, "TelegramGetRecentPhotos must be registered")
  const result = await tool.run({ chat_id: 1515784684, limit: 5 }, { rootDir: testMonolitoRoot, cwd: testMonolitoRoot }) as RecentPhotosResult
  assert.equal(result.ok, true)
  assert.equal(result.count, 3)
  assert.equal(result.photos[0].message_id, 102, "most recent first")
  assert.equal(result.photos[0].file_id, "file_id_new")
  assert.equal(result.photos[0].caption, "new caption")
  assert.equal(result.photos[2].message_id, 100, "oldest last")
})

test("TelegramGetRecentPhotos respects limit and filters by chat_id", async () => {
  clearSentPhotos()
  const db = getDb(testMonolitoRoot)
  const stmt = db.prepare(`
    INSERT INTO telegram_sent_photos (chat_id, message_id, file_id, local_path, caption, sent_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  stmt.run(111, 1, "f1", "/tmp/a1.jpg", null, "2026-06-06 10:00:00")
  stmt.run(111, 2, "f2", "/tmp/a2.jpg", null, "2026-06-06 10:01:00")
  stmt.run(111, 3, "f3", "/tmp/a3.jpg", null, "2026-06-06 10:02:00")
  stmt.run(111, 4, "f4", "/tmp/a4.jpg", null, "2026-06-06 10:03:00")
  stmt.run(222, 5, "f5", "/tmp/b1.jpg", null, "2026-06-06 10:04:00")
  stmt.run(222, 6, "f6", "/tmp/b2.jpg", null, "2026-06-06 10:05:00")

  const tool = getTool("TelegramGetRecentPhotos")
  assert.ok(tool)
  const resultA = await tool.run({ chat_id: 111, limit: 3 }, { rootDir: testMonolitoRoot, cwd: testMonolitoRoot }) as RecentPhotosResult
  assert.equal(resultA.count, 3)
  assert.deepEqual(resultA.photos.map((p: SentPhotoRow) => p.message_id), [4, 3, 2])
  const resultB = await tool.run({ chat_id: 222, limit: 5 }, { rootDir: testMonolitoRoot, cwd: testMonolitoRoot }) as RecentPhotosResult
  assert.equal(resultB.count, 2)
  assert.deepEqual(resultB.photos.map((p: SentPhotoRow) => p.message_id), [6, 5])
})

test("TelegramGetRecentPhotos normalizes limit (clamped to 1..20)", async () => {
  clearSentPhotos()
  const tool = getTool("TelegramGetRecentPhotos")
  assert.ok(tool)
  const result = await tool.run({ limit: 0 }, { rootDir: testMonolitoRoot, cwd: testMonolitoRoot }) as RecentPhotosResult
  assert.equal(result.ok, true)
  assert.equal(result.count, 0)
  const result2 = await tool.run({ limit: 99999 }, { rootDir: testMonolitoRoot, cwd: testMonolitoRoot }) as RecentPhotosResult
  assert.equal(result2.count, 0)
})

test("TelegramGetRecentPhotos normalizes synthetic <remote:...> marker as null local_path", async () => {
  clearSentPhotos()
  const db = getDb(testMonolitoRoot)
  db.prepare(`
    INSERT INTO telegram_sent_photos (chat_id, message_id, file_id, local_path, caption, sent_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(1515784684, 200, "remote_file_id", "<remote:https://example.com/foo.jpg>", null, "2026-06-06 12:00:00")

  const tool = getTool("TelegramGetRecentPhotos")
  assert.ok(tool)
  const result = await tool.run({ chat_id: 1515784684 }, { rootDir: testMonolitoRoot, cwd: testMonolitoRoot }) as RecentPhotosResult
  assert.equal(result.count, 1)
  assert.equal(result.photos[0].file_id, "remote_file_id")
  assert.equal(result.photos[0].local_path, null)
})

test("TelegramGetRecentPhotos: validation errors on bad input", () => {
  const tool = getTool("TelegramGetRecentPhotos")
  assert.ok(tool)
  assert.match(tool.validate!({ chat_id: "not-a-number" })!, /chat_id must be a number/)
  assert.match(tool.validate!({ limit: 0 })!, /limit must be a positive number/)
  assert.match(tool.validate!({ limit: -1 })!, /limit must be a positive number/)
  assert.match(tool.validate!({ limit: "5" })!, /limit must be a positive number/)
})
