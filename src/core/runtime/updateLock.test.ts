// Tests para updateLock.ts
//
// IMPORTANT: this test MUST be run serially because it manipulates the
// filesystem in a real run/ directory. Run with:
//   node --experimental-strip-types --test src/core/runtime/updateLock.test.ts

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquireUpdateLock,
  isPidAlive,
  readUpdateLockMetadata,
  MAX_UPDATE_LOCK_AGE_MS,
} from "./updateLock.ts"

function freshRootDir(): string {
  const root = mkdtempSync(join(tmpdir(), "monolito-update-lock-test-"))
  // ensureMonolitoRoot is normally called by callers, but acquireUpdateLock
  // uses getPaths().runDir. We mimic that by pre-creating the run dir.
  // The test relies on getPaths() returning a path inside our root.
  return root
}

test("isPidAlive: returns true for the current process", () => {
  assert.equal(isPidAlive(process.pid), true)
})

test("isPidAlive: returns false for a clearly bogus pid", () => {
  // PIDs above ~4M are not in use on Linux for the first few minutes after boot.
  // We pick something astronomically high that's never been assigned.
  assert.equal(isPidAlive(999_999_999), false)
})

test("readUpdateLockMetadata: returns null for missing file", () => {
  const result = readUpdateLockMetadata("/tmp/does-not-exist-" + Date.now() + ".lock")
  assert.equal(result, null)
})

test("readUpdateLockMetadata: returns null for empty file", () => {
  const path = join(tmpdir(), "empty-lock-" + Date.now() + ".lock")
  writeFileSync(path, "")
  try {
    assert.equal(readUpdateLockMetadata(path), null)
  } finally {
    rmSync(path, { force: true })
  }
})

test("readUpdateLockMetadata: returns null for invalid JSON", () => {
  const path = join(tmpdir(), "bad-json-lock-" + Date.now() + ".lock")
  writeFileSync(path, "not json at all")
  try {
    assert.equal(readUpdateLockMetadata(path), null)
  } finally {
    rmSync(path, { force: true })
  }
})

test("readUpdateLockMetadata: returns null for JSON missing fields", () => {
  const path = join(tmpdir(), "missing-fields-lock-" + Date.now() + ".lock")
  writeFileSync(path, JSON.stringify({ pid: 123 })) // no startedAt
  try {
    assert.equal(readUpdateLockMetadata(path), null)
  } finally {
    rmSync(path, { force: true })
  }
})

test("readUpdateLockMetadata: returns valid metadata for well-formed lock", () => {
  const path = join(tmpdir(), "good-lock-" + Date.now() + ".lock")
  const meta = { pid: 42, startedAt: "2026-06-08T12:00:00Z" }
  writeFileSync(path, JSON.stringify(meta))
  try {
    const result = readUpdateLockMetadata(path)
    assert.deepEqual(result, meta)
  } finally {
    rmSync(path, { force: true })
  }
})

test("acquireUpdateLock: happy path — takes lock and releases on release()", () => {
  const rootDir = freshRootDir()
  try {
    const r1 = acquireUpdateLock(rootDir)
    assert.equal(r1.ok, true)
    if (r1.ok) {
      // Lock file must exist now.
      assert.ok(existsSync(r1.lockPath), "lock file should exist after acquire")
      // Content must have pid + startedAt.
      const content = readFileSync(r1.lockPath, "utf8")
      const parsed = JSON.parse(content) as { pid: number; startedAt: string }
      assert.equal(parsed.pid, process.pid)
      assert.ok(typeof parsed.startedAt === "string")

      r1.release()
      assert.ok(!existsSync(r1.lockPath), "lock file should be removed after release")
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test("acquireUpdateLock: refuses when another live process owns the lock", () => {
  const rootDir = freshRootDir()
  try {
    const r1 = acquireUpdateLock(rootDir)
    assert.equal(r1.ok, true)
    if (!r1.ok) return

    // Simulate "another process" by writing a lock owned by a different (alive) PID
    // that we don't release. Use process.pid (this test) for the first lock, then
    // a second acquire should fail because the first one is still held.
    const r2 = acquireUpdateLock(rootDir)
    assert.equal(r2.ok, false)
    if (!r2.ok) {
      assert.match(r2.message, /already in progress/)
      assert.match(r2.message, new RegExp(`pid=${process.pid}`))
    }

    r1.release()
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test("acquireUpdateLock: removes stale lock (PID dead) and acquires fresh", () => {
  const rootDir = freshRootDir()
  try {
    // Plant a stale lock: a PID that we know doesn't exist anymore.
    // First take a lock to create the run/ dir, then write our own stale one.
    const r0 = acquireUpdateLock(rootDir)
    assert.equal(r0.ok, true)
    if (!r0.ok) return
    r0.release()

    // Now overwrite with a "stale" lock (dead PID).
    const staleMeta = JSON.stringify({ pid: 9_999_999, startedAt: new Date().toISOString() })
    writeFileSync(r0.lockPath, staleMeta + "\n")

    // Acquire should detect the stale lock and take it.
    const r1 = acquireUpdateLock(rootDir)
    assert.equal(r1.ok, true)
    if (r1.ok) {
      const content = readFileSync(r1.lockPath, "utf8")
      const parsed = JSON.parse(content) as { pid: number; startedAt: string }
      assert.equal(parsed.pid, process.pid, "lock should now belong to this process")
      r1.release()
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test("acquireUpdateLock: removes stale lock (age > MAX) even if PID is alive", () => {
  const rootDir = freshRootDir()
  try {
    const r0 = acquireUpdateLock(rootDir)
    assert.equal(r0.ok, true)
    if (!r0.ok) return
    r0.release()

    // Plant a lock with a fresh PID (this process) but very old startedAt.
    // The "PID alive" check would say "yes, alive" — but age > MAX forces stale.
    const oldDate = new Date(Date.now() - MAX_UPDATE_LOCK_AGE_MS - 60_000).toISOString()
    const meta = { pid: process.pid, startedAt: oldDate }
    writeFileSync(r0.lockPath, JSON.stringify(meta) + "\n")

    const r1 = acquireUpdateLock(rootDir)
    assert.equal(r1.ok, true)
    if (r1.ok) {
      const content = readFileSync(r1.lockPath, "utf8")
      const parsed = JSON.parse(content) as { pid: number; startedAt: string }
      // New lock should have a fresh startedAt, not the old one.
      assert.notEqual(parsed.startedAt, oldDate, "startedAt should be refreshed")
      r1.release()
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test("acquireUpdateLock: removes corrupt lock and acquires fresh", () => {
  const rootDir = freshRootDir()
  try {
    const r0 = acquireUpdateLock(rootDir)
    assert.equal(r0.ok, true)
    if (!r0.ok) return
    r0.release()

    // Plant a corrupt lock file.
    writeFileSync(r0.lockPath, "this is not valid json {{{\n")

    const r1 = acquireUpdateLock(rootDir)
    assert.equal(r1.ok, true)
    if (r1.ok) {
      r1.release()
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test("acquireUpdateLock: refuses when an active lock has a recent startedAt and live PID", () => {
  const rootDir = freshRootDir()
  try {
    // Take and DO NOT release — simulates an in-progress update.
    const r1 = acquireUpdateLock(rootDir)
    assert.equal(r1.ok, true)
    if (!r1.ok) return

    // Second acquire must refuse with diagnostics.
    const r2 = acquireUpdateLock(rootDir)
    assert.equal(r2.ok, false)
    if (!r2.ok) {
      assert.match(r2.message, /already in progress/)
      assert.match(r2.message, /pid=/)
      assert.match(r2.message, /age=/)
    }

    r1.release()
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test("acquireUpdateLock: release() is idempotent (safe to call twice)", () => {
  const rootDir = freshRootDir()
  try {
    const r1 = acquireUpdateLock(rootDir)
    assert.equal(r1.ok, true)
    if (!r1.ok) return
    r1.release()
    // Second release must not throw.
    r1.release()
    assert.ok(!existsSync(r1.lockPath))
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test("acquireUpdateLock: after release, next acquire succeeds", () => {
  const rootDir = freshRootDir()
  try {
    const r1 = acquireUpdateLock(rootDir)
    assert.equal(r1.ok, true)
    if (!r1.ok) return
    r1.release()

    const r2 = acquireUpdateLock(rootDir)
    assert.equal(r2.ok, true)
    if (r2.ok) r2.release()
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})
