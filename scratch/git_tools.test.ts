import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getTool } from "../src/core/tools/registry.ts"

function createRootDir() {
  const rootDir = mkdtempSync(join(tmpdir(), "monolito-git-test-"))
  spawnSync("git", ["init"], { cwd: rootDir })
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: rootDir })
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: rootDir })
  return rootDir
}

function cleanupRootDir(rootDir: string) {
  rmSync(rootDir, { recursive: true, force: true })
}

test("Git tools: status, diff, add, commit", async () => {
  const rootDir = createRootDir()
  try {
    const gitStatus = getTool("GitStatus")
    const gitDiff = getTool("GitDiff")
    const gitDiffCached = getTool("GitDiffCached")
    const gitAdd = getTool("GitAdd")
    const gitCommit = getTool("GitCommit")

    assert.ok(gitStatus)
    assert.ok(gitDiff)
    assert.ok(gitDiffCached)
    assert.ok(gitAdd)
    assert.ok(gitCommit)

    // 1. Initial status
    let res = await gitStatus.run({}, { rootDir, cwd: rootDir }) as any
    assert.equal(res.status, "(clean)")

    // 2. Create a file
    writeFileSync(join(rootDir, "test.txt"), "hello")
    res = await gitStatus.run({}, { rootDir, cwd: rootDir }) as any
    assert.ok(res.status.includes("?? test.txt"))

    // 3. Diff (unstaged)
    // git diff doesn't show untracked files by default, so let's track it first
    await gitAdd.run({ path: "test.txt" }, { rootDir, cwd: rootDir })
    
    // Now it's staged
    res = await gitStatus.run({}, { rootDir, cwd: rootDir }) as any
    assert.ok(res.status.includes("A  test.txt"))

    res = await gitDiffCached.run({}, { rootDir, cwd: rootDir }) as any
    assert.ok(res.diff.includes("+hello"))

    // 4. Commit
    res = await gitCommit.run({ message: "initial commit" }, { rootDir, cwd: rootDir }) as any
    assert.ok(res.result.includes("initial commit"))

    res = await gitStatus.run({}, { rootDir, cwd: rootDir }) as any
    assert.equal(res.status, "(clean)")

    // 5. Modify file
    writeFileSync(join(rootDir, "test.txt"), "world")
    res = await gitDiff.run({}, { rootDir, cwd: rootDir }) as any
    assert.ok(res.diff.includes("-hello"))
    assert.ok(res.diff.includes("+world"))

  } finally {
    cleanupRootDir(rootDir)
  }
})
