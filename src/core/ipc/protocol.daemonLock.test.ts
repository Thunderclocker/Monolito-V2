import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getPaths, readDaemonLock } from "./protocol.ts"

function withRoot(run: (rootDir: string) => void) {
  const rootDir = mkdtempSync(join(tmpdir(), "monolito-daemon-lock-"))
  try {
    mkdirSync(getPaths(rootDir).runDir, { recursive: true })
    run(rootDir)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

function writeLock(rootDir: string, value: unknown) {
  writeFileSync(getPaths(rootDir).lockFile, `${JSON.stringify(value)}\n`, "utf8")
}

test("readDaemonLock accepts the expected unix lock for this root", () => {
  withRoot(rootDir => {
    const paths = getPaths(rootDir)
    const lock = {
      pid: 1234,
      startedAt: "2026-09-06T00:00:00.000Z",
      transport: "unix",
      socketPath: paths.socketPath,
    }
    writeLock(rootDir, lock)
    assert.deepEqual(readDaemonLock(rootDir), lock)
  })
})

test("readDaemonLock rejects malformed or redirected lock data", () => {
  withRoot(rootDir => {
    const paths = getPaths(rootDir)
    const invalidLocks = [
      { pid: -1, startedAt: "2026-09-06T00:00:00.000Z", transport: "unix", socketPath: paths.socketPath },
      { pid: 1234.5, startedAt: "2026-09-06T00:00:00.000Z", transport: "unix", socketPath: paths.socketPath },
      { pid: 1234, startedAt: "not-a-date", transport: "unix", socketPath: paths.socketPath },
      { pid: 1234, startedAt: "2026-09-06T00:00:00.000Z", transport: "unix", socketPath: "/tmp/attacker.sock" },
      { pid: 1234, startedAt: "2026-09-06T00:00:00.000Z", transport: "tcp", host: "0.0.0.0", port: paths.tcpPort },
      { pid: 1234, startedAt: "2026-09-06T00:00:00.000Z", transport: "tcp", host: paths.tcpHost, port: 70000 },
      { pid: 1234, startedAt: "2026-09-06T00:00:00.000Z", transport: "bogus", socketPath: paths.socketPath },
    ]

    for (const value of invalidLocks) {
      writeLock(rootDir, value)
      assert.equal(readDaemonLock(rootDir), null)
    }
  })
})
