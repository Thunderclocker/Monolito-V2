// Tests para file-history.ts

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  trackEdit,
  getHistory,
  restoreFromHistory,
  listSessionHistory,
  snapshotFile,
  clearSessionHistory,
} from "./file-history.ts"

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "monolito-file-history-"))
}

test("trackEdit stores content and returns entry", () => {
  const root = makeRoot()
  try {
    const entry = trackEdit(root, "sess-1", "docs/readme.md", "hello v1")
    assert.equal(entry.sessionId, "sess-1")
    assert.equal(entry.path, "docs/readme.md")
    assert.equal(entry.version, 1)
    assert.ok(entry.contentHash.length > 0)
    assert.equal(entry.sizeBytes, 8)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("version increments on each trackEdit", () => {
  const root = makeRoot()
  try {
    const e1 = trackEdit(root, "sess-2", "f.txt", "v1")
    const e2 = trackEdit(root, "sess-2", "f.txt", "v2")
    const e3 = trackEdit(root, "sess-2", "f.txt", "v3")
    assert.equal(e1.version, 1)
    assert.equal(e2.version, 2)
    assert.equal(e3.version, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("getHistory returns versions in descending order", () => {
  const root = makeRoot()
  try {
    trackEdit(root, "sess-3", "f.txt", "a")
    trackEdit(root, "sess-3", "f.txt", "b")
    trackEdit(root, "sess-3", "f.txt", "c")
    const list = getHistory(root, "sess-3", "f.txt")
    assert.equal(list.length, 3)
    assert.equal(list[0].version, 3)
    assert.equal(list[1].version, 2)
    assert.equal(list[2].version, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("restoreFromHistory recovers prior content", () => {
  const root = makeRoot()
  try {
    trackEdit(root, "sess-4", "config.json", '{"a":1}')
    trackEdit(root, "sess-4", "config.json", '{"a":2}')
    trackEdit(root, "sess-4", "config.json", '{"a":3}')
    const result = restoreFromHistory(root, "sess-4", "config.json", 1)
    assert.equal(result.restored, true)
    assert.equal(result.content, '{"a":1}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("restoreFromHistory returns false for missing version", () => {
  const root = makeRoot()
  try {
    trackEdit(root, "sess-5", "f.txt", "x")
    const result = restoreFromHistory(root, "sess-5", "f.txt", 99)
    assert.equal(result.restored, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("snapshotFile copies a real file to backup dir", () => {
  const root = makeRoot()
  try {
    const source = join(root, "source.txt")
    writeFileSync(source, "important data")
    const backupDir = join(root, "backups")
    const result = snapshotFile(source, backupDir)
    assert.ok(result)
    assert.ok(result!.backupPath.startsWith(backupDir))
    assert.equal(readFileSync(result!.backupPath, "utf8"), "important data")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("snapshotFile returns null if source does not exist", () => {
  const root = makeRoot()
  try {
    const result = snapshotFile(join(root, "nope.txt"), join(root, "backups"))
    assert.equal(result, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("listSessionHistory returns all paths for a session", () => {
  const root = makeRoot()
  try {
    trackEdit(root, "sess-6", "a.txt", "1")
    trackEdit(root, "sess-6", "b.txt", "2")
    trackEdit(root, "sess-6", "a.txt", "1b")
    const list = listSessionHistory(root, "sess-6")
    assert.equal(list.length, 3)
    const paths = list.map(e => e.path).sort()
    assert.deepEqual(paths, ["a.txt", "a.txt", "b.txt"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("clearSessionHistory removes everything for the session", () => {
  const root = makeRoot()
  try {
    trackEdit(root, "sess-7", "a.txt", "1")
    trackEdit(root, "sess-7", "b.txt", "2")
    clearSessionHistory(root, "sess-7")
    const list = listSessionHistory(root, "sess-7")
    assert.equal(list.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("history persists across calls", () => {
  const root = makeRoot()
  try {
    trackEdit(root, "sess-8", "stable.txt", "v1")
    // Call again, simulate "session continues"
    const list = getHistory(root, "sess-8", "stable.txt")
    assert.equal(list.length, 1)
    assert.equal(list[0].version, 1)
    // Verify the physical file exists
    const historyRoot = join(root, ".claude", "file-history", "sess-8")
    assert.ok(existsSync(historyRoot))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
