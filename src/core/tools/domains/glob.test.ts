// Baseline test para Glob (file.ts:221-258). Fase 0 protection:
// cualquier cambio de framework que rompa el shape del tool o el comportamiento
// del runRg va a fallar acá.

import test, { after } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-glob-test-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

const { getTool } = await import("../registry.ts")

after(() => {
  rmSync(testMonolitoRoot, { recursive: true, force: true })
})

function hasRipgrep(): boolean {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const RG_AVAILABLE = hasRipgrep()

function makeRootDir(): string {
  return mkdtempSync(join(tmpdir(), "monolito-glob-root-"))
}

function cleanupRootDir(rootDir: string) {
  rmSync(rootDir, { recursive: true, force: true })
}

function makeToolContext(rootDir: string) {
  return {
    rootDir,
    cwd: rootDir,
    sessionId: "test-session",
    profileId: "default",
    logger: undefined,
    abortSignal: undefined,
    traceId: undefined,
    permissionTier: "read" as const,
  }
}

test("Glob tool is registered and has the right shape", () => {
  const tool = getTool("Glob")
  assert.ok(tool, "Glob tool must be registered")
  assert.equal(tool!.permissionTier, "read")
  assert.equal(tool!.concurrencySafe, true)
  assert.equal(tool!.validate?.({}), "pattern must be a non-empty string")
  assert.equal(tool!.validate?.({ pattern: "" }), "pattern must be a non-empty string")
  assert.equal(tool!.validate?.({ pattern: "*.ts" }), null)
})

test("Glob finds files matching pattern", { skip: !RG_AVAILABLE }, async () => {
  const root = makeRootDir()
  try {
    writeFileSync(join(root, "foo.ts"), "x")
    writeFileSync(join(root, "bar.ts"), "y")
    writeFileSync(join(root, "baz.js"), "z")
    mkdirSync(join(root, "sub"))
    writeFileSync(join(root, "sub", "qux.ts"), "w")

    const tool = getTool("Glob")!
    const result = await tool.run(
      { pattern: "*.ts" },
      makeToolContext(root),
    ) as { numFiles: number; filenames: string[]; truncated: boolean }

    assert.equal(result.numFiles, 2)
    assert.deepEqual(result.filenames.sort(), ["bar.ts", "foo.ts"])
  } finally {
    cleanupRootDir(root)
  }
})

test("Glob respects head_limit and offset", { skip: !RG_AVAILABLE }, async () => {
  const root = makeRootDir()
  try {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(root, `f${i}.txt`), "x")
    }
    const tool = getTool("Glob")!
    const result = await tool.run(
      { pattern: "*.txt", head_limit: 3, offset: 2 },
      makeToolContext(root),
    ) as { numFiles: number; truncated: boolean; appliedLimit?: number; appliedOffset: number }

    assert.equal(result.numFiles, 3, "head_limit caps results")
    assert.equal(result.truncated, true, "truncation flag set")
    assert.equal(result.appliedLimit, 3)
    assert.equal(result.appliedOffset, 2)
  } finally {
    cleanupRootDir(root)
  }
})

test("Glob with head_limit=0 means unlimited", { skip: !RG_AVAILABLE }, async () => {
  const root = makeRootDir()
  try {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, `g${i}.txt`), "x")
    }
    const tool = getTool("Glob")!
    const result = await tool.run(
      { pattern: "*.txt", head_limit: 0 },
      makeToolContext(root),
    ) as { numFiles: number; truncated: boolean; appliedLimit?: number }

    assert.equal(result.numFiles, 5)
    assert.equal(result.truncated, false, "unlimited → no truncation")
    assert.equal(result.appliedLimit, undefined)
  } finally {
    cleanupRootDir(root)
  }
})

test("Glob search in subdirectory", { skip: !RG_AVAILABLE }, async () => {
  const root = makeRootDir()
  try {
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "a.ts"), "x")
    writeFileSync(join(root, "src", "b.ts"), "y")
    writeFileSync(join(root, "c.ts"), "z") // not under src/

    const tool = getTool("Glob")!
    const result = await tool.run(
      { pattern: "*.ts", path: "src" },
      makeToolContext(root),
    ) as { numFiles: number; filenames: string[] }

    assert.equal(result.numFiles, 2)
    assert.ok(result.filenames.every(f => f.includes("src")))
  } finally {
    cleanupRootDir(root)
  }
})

test("Glob rejects invalid input", () => {
  const tool = getTool("Glob")!
  assert.equal(tool.validate!({}), "pattern must be a non-empty string")
  assert.equal(tool.validate!({ pattern: 123 }), "pattern must be a non-empty string")
})
