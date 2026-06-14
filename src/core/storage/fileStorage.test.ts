import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configWingPath, sessionMetaPath, sessionMessagesPath } from "./filePaths.ts"
import { getFileStorage } from "./fileStorage.ts"

const root = mkdtempSync(join(tmpdir(), "monolito-file-storage-"))
process.env.MONOLITO_ROOT = root
process.env.MONOLITO_STORAGE_BACKEND = "files"

test.after(() => {
  rmSync(root, { recursive: true, force: true })
})

test("file storage: seeds config wings and creates sessions", () => {
  const fs = getFileStorage(root)
  fs.ensureKernelSeeded()
  assert.ok(existsSync(configWingPath(root, "CONF_MODELS")))
  assert.ok(existsSync(configWingPath(root, "CONF_CHANNELS")))

  const session = fs.createSession("Test session", "orchestrator")
  assert.equal(session.id, "orchestrator")
  assert.ok(existsSync(sessionMetaPath(root, "orchestrator")))

  fs.appendMessage("orchestrator", "user", "hola mundo")
  const msgs = fs.readMessages("orchestrator")
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0]!.role, "user")
  assert.ok(existsSync(sessionMessagesPath(root, "orchestrator")))
})

test("file storage: keyword search over messages", () => {
  const fs = getFileStorage(root)
  fs.createSession("Search", "search-test")
  fs.appendMessage("search-test", "user", "Linux Mint seguridad firewall")
  const hits = fs.searchMessages("seguridad linux", 5)
  assert.ok(hits.some(h => h.text.includes("seguridad")))
})

test("file storage: session tasks supersede", () => {
  const fs = getFileStorage(root)
  fs.createSession("Tasks", "task-session")
  fs.writeSessionTask("task-session", "t1", {
    id: "t1",
    content: "Do thing",
    status: "pending",
    createdAt: new Date().toISOString(),
  })
  assert.equal(fs.listSessionTasks("task-session").length, 1)
  fs.supersedeAllSessionTasks("task-session")
  assert.equal(fs.listSessionTasks("task-session").length, 0)
})
