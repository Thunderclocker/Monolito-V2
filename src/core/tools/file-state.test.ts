// Tests para file-state.ts — readFileState LRU + staleness detection

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getReadFileStateForTool,
  setReadFileStateForTool,
  clearReadFileStateForTool,
  clearSessionReadFileState,
  isFileStale,
  fingerprint,
} from "./file-state.ts"

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "monolito-file-state-"))
}

test("setReadFileStateForTool stores and retrieves entry", () => {
  const root = makeRoot()
  try {
    const path = "foo.txt"
    writeFileSync(join(root, path), "hello world")
    const entry = setReadFileStateForTool("sess-1", root, path, "hello world")
    assert.equal(entry.content, "hello world")
    assert.equal(entry.sizeBytes, 11)
    const got = getReadFileStateForTool("sess-1", root, path)
    assert.ok(got)
    assert.equal(got!.content, "hello world")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("isFileStale returns true after file mtime changes", async () => {
  const root = makeRoot()
  try {
    const path = "stale.txt"
    const abs = join(root, path)
    writeFileSync(abs, "v1")
    setReadFileStateForTool("sess-2", root, path, "v1")
    // Wait > 1s to ensure mtime granularity difference
    await new Promise(r => setTimeout(r, 1100))
    writeFileSync(abs, "v2")
    utimesSync(abs, new Date(), new Date())
    const { stale } = isFileStale("sess-2", root, path)
    assert.equal(stale, true, "expected file to be stale after mtime change")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("isFileStale returns false when mtime unchanged", () => {
  const root = makeRoot()
  try {
    const path = "fresh.txt"
    writeFileSync(join(root, path), "stable")
    setReadFileStateForTool("sess-3", root, path, "stable")
    const { stale } = isFileStale("sess-3", root, path)
    assert.equal(stale, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("clearReadFileStateForTool removes specific entry", () => {
  const root = makeRoot()
  try {
    writeFileSync(join(root, "a.txt"), "a")
    writeFileSync(join(root, "b.txt"), "b")
    setReadFileStateForTool("sess-4", root, "a.txt", "a")
    setReadFileStateForTool("sess-4", root, "b.txt", "b")
    clearReadFileStateForTool("sess-4", root, "a.txt")
    assert.equal(getReadFileStateForTool("sess-4", root, "a.txt"), undefined)
    assert.ok(getReadFileStateForTool("sess-4", root, "b.txt"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("clearSessionReadFileState removes all entries for session", () => {
  const root = makeRoot()
  try {
    writeFileSync(join(root, "a.txt"), "a")
    writeFileSync(join(root, "b.txt"), "b")
    setReadFileStateForTool("sess-5", root, "a.txt", "a")
    setReadFileStateForTool("sess-5", root, "b.txt", "b")
    clearSessionReadFileState("sess-5")
    assert.equal(getReadFileStateForTool("sess-5", root, "a.txt"), undefined)
    assert.equal(getReadFileStateForTool("sess-5", root, "b.txt"), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("LRU eviction kicks in at maxEntries", () => {
  const root = makeRoot()
  try {
    const sess = "sess-lru"
    for (let i = 0; i < 5; i++) {
      const p = `f${i}.txt`
      writeFileSync(join(root, p), `v${i}`)
      setReadFileStateForTool(sess, root, p, `v${i}`, {}, 3)
    }
    // 5 inserts with max 3 → only last 3 remain
    assert.equal(getReadFileStateForTool(sess, root, "f0.txt"), undefined, "f0 should be evicted")
    assert.equal(getReadFileStateForTool(sess, root, "f1.txt"), undefined, "f1 should be evicted")
    assert.ok(getReadFileStateForTool(sess, root, "f2.txt"), "f2 should remain")
    assert.ok(getReadFileStateForTool(sess, root, "f3.txt"), "f3 should remain")
    assert.ok(getReadFileStateForTool(sess, root, "f4.txt"), "f4 should remain")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("fingerprint is deterministic for same content", () => {
  assert.equal(fingerprint("hello"), fingerprint("hello"))
  assert.notEqual(fingerprint("hello"), fingerprint("world"))
  assert.equal(fingerprint("hello").length, 16)
})
