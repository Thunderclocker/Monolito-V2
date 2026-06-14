import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-sent-photos-test-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

const { getTool } = await import("../registry.ts")
const { persistTelegramSentPhoto, writeConfigWing } = await import("../../session/store.ts")
const { telegramSentPhotosPath } = await import("../../storage/filePaths.ts")

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
  writeFileSync(telegramSentPhotosPath(testMonolitoRoot), "", "utf8")
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
  persistTelegramSentPhoto(testMonolitoRoot, {
    chatId: 1515784684,
    messageId: 100,
    fileId: "file_id_old",
    localPath: "/tmp/old.jpg",
    caption: "old caption",
  })
  persistTelegramSentPhoto(testMonolitoRoot, {
    chatId: 1515784684,
    messageId: 101,
    fileId: "file_id_mid",
    localPath: "/tmp/mid.jpg",
    caption: null,
  })
  persistTelegramSentPhoto(testMonolitoRoot, {
    chatId: 1515784684,
    messageId: 102,
    fileId: "file_id_new",
    localPath: "/tmp/new.jpg",
    caption: "new caption",
  })

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
  persistTelegramSentPhoto(testMonolitoRoot, { chatId: 111, messageId: 1, fileId: "f1", localPath: "/tmp/a1.jpg", caption: null })
  persistTelegramSentPhoto(testMonolitoRoot, { chatId: 111, messageId: 2, fileId: "f2", localPath: "/tmp/a2.jpg", caption: null })
  persistTelegramSentPhoto(testMonolitoRoot, { chatId: 111, messageId: 3, fileId: "f3", localPath: "/tmp/a3.jpg", caption: null })
  persistTelegramSentPhoto(testMonolitoRoot, { chatId: 111, messageId: 4, fileId: "f4", localPath: "/tmp/a4.jpg", caption: null })
  persistTelegramSentPhoto(testMonolitoRoot, { chatId: 222, messageId: 5, fileId: "f5", localPath: "/tmp/b1.jpg", caption: null })
  persistTelegramSentPhoto(testMonolitoRoot, { chatId: 222, messageId: 6, fileId: "f6", localPath: "/tmp/b2.jpg", caption: null })

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
  persistTelegramSentPhoto(testMonolitoRoot, {
    chatId: 1515784684,
    messageId: 200,
    fileId: "remote_file_id",
    localPath: "<remote:https://example.com/foo.jpg>",
    caption: null,
  })

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
