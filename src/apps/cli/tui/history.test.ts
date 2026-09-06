import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { tmpdir } from "node:os"
import { getHistoryFilePath, writePromptHistory } from "./history.ts"

const mode = (path: string) => statSync(path).mode & 0o777

test("writePromptHistory creates and normalizes private state/history permissions", () => {
  const rootDir = mkdtempSync(`${tmpdir()}/monolito-history-`)
  try {
    writePromptHistory(rootDir, ["hello"])
    const filePath = getHistoryFilePath(rootDir)
    const stateDir = dirname(filePath)

    assert.equal(mode(stateDir), 0o700)
    assert.equal(mode(filePath), 0o600)

    chmodSync(stateDir, 0o755)
    chmodSync(filePath, 0o644)
    writePromptHistory(rootDir, ["world"])

    assert.equal(mode(stateDir), 0o700)
    assert.equal(mode(filePath), 0o600)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})
