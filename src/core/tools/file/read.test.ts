// Tests para file/read.ts — streaming, dedup, device guard, binary reject

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFile, MAX_READ_SIZE_BYTES } from "./read.ts"
import { getReadFileStateForTool, isFileStale } from "../file-state.ts"

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "monolito-read-test-"))
}

test("readFile returns text content for small file", async () => {
  const root = makeRoot()
  try {
    const path = join(root, "hello.txt")
    writeFileSync(path, "line1\nline2\nline3")
    const result = await readFile({
      sessionId: "sess-1",
      rootDir: root,
      cwd: root,
      path,
    })
    assert.equal(result.type, "text")
    assert.equal(result.content, "line1\nline2\nline3")
    assert.equal(result.totalLines, 3)
    assert.equal(result.returnedLines, 3)
    assert.equal(result.hasMore, false)
    assert.equal(result.bytes, 17)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("readFile populates readFileState", async () => {
  const root = makeRoot()
  try {
    const path = join(root, "x.txt")
    writeFileSync(path, "hello")
    await readFile({ sessionId: "sess-2", rootDir: root, cwd: root, path })
    const entry = getReadFileStateForTool("sess-2", root, path)
    assert.ok(entry, "readFileState should be populated")
    assert.equal(entry!.content, "hello")
    assert.equal(entry!.sizeBytes, 5)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("readFile with offset and line_limit", async () => {
  const root = makeRoot()
  try {
    const path = join(root, "x.txt")
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
    writeFileSync(path, lines)
    const result = await readFile({
      sessionId: "sess-3",
      rootDir: root,
      cwd: root,
      path,
      offset: 3,
      line_limit: 2,
    })
    assert.equal(result.type, "text")
    assert.equal(result.content, "line3\nline4")
    assert.equal(result.totalLines, 10)
    assert.equal(result.returnedLines, 2)
    assert.equal(result.hasMore, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("readFile returns file_too_large for files over cap", async () => {
  const root = makeRoot()
  try {
    const path = join(root, "big.txt")
    // Crear archivo > 256KB
    const big = "x".repeat(MAX_READ_SIZE_BYTES + 100)
    writeFileSync(path, big)
    const result = await readFile({
      sessionId: "sess-4",
      rootDir: root,
      cwd: root,
      path,
    })
    assert.equal(result.type, "file_too_large")
    assert.ok(result.bytes > MAX_READ_SIZE_BYTES)
    assert.ok(result.file_unchanged, "should include dedup hash")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("readFile returns binary for files with NUL bytes", async () => {
  const root = makeRoot()
  try {
    const path = join(root, "blob.bin")
    const buf = Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]) // "He\0lo"
    writeFileSync(path, buf)
    const result = await readFile({
      sessionId: "sess-5",
      rootDir: root,
      cwd: root,
      path,
    })
    assert.equal(result.type, "binary")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("readFile blocks device files", async () => {
  const root = makeRoot()
  try {
    const result = await readFile({
      sessionId: "sess-6",
      rootDir: root,
      cwd: root,
      path: "/dev/null",
    })
    assert.equal(result.type, "device_file")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("readFile returns not_found for missing files", async () => {
  const root = makeRoot()
  try {
    const result = await readFile({
      sessionId: "sess-7",
      rootDir: root,
      cwd: root,
      path: join(root, "nope.txt"),
    })
    assert.equal(result.type, "not_found")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("stale detection after file mtime change", async () => {
  const root = makeRoot()
  try {
    const path = join(root, "mutated.txt")
    writeFileSync(path, "v1")
    await readFile({ sessionId: "sess-8", rootDir: root, cwd: root, path })
    // Wait > 1s to ensure mtime granularity
    await new Promise(r => setTimeout(r, 1100))
    writeFileSync(path, "v2")
    utimesSync(path, new Date(), new Date())
    const { stale } = isFileStale("sess-8", root, path)
    assert.equal(stale, true, "file should be detected as stale after mtime change")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("readFile populates mtime in readFileState for staleness checks", async () => {
  const root = makeRoot()
  try {
    const path = join(root, "m.txt")
    writeFileSync(path, "x")
    await readFile({ sessionId: "sess-9", rootDir: root, cwd: root, path })
    const entry = getReadFileStateForTool("sess-9", root, path)
    assert.ok(entry!.mtime > 0, "mtime should be recorded")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
