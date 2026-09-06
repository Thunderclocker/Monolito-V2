import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import {
  isSensitiveHistoryEntry,
  pushPromptHistory,
  readPromptHistory,
  writePromptHistory,
} from "./history.ts"

const sensitiveSamples = [
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
  "sk-abcdefghijklmnopqrstuvwxyz123456",
  "token=supersecretvalue",
  "clientSecret: anothersecretvalue",
  "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
]

test("isSensitiveHistoryEntry detects common pasted secrets", () => {
  for (const sample of sensitiveSamples) assert.equal(isSensitiveHistoryEntry(sample), true, sample)
  assert.equal(isSensitiveHistoryEntry("explain how bearer authentication works"), false)
  assert.equal(isSensitiveHistoryEntry("show token accounting logic"), false)
})

test("pushPromptHistory refuses sensitive entries", () => {
  for (const sample of sensitiveSamples) {
    assert.deepEqual(pushPromptHistory(["safe prompt"], sample), ["safe prompt"])
  }
})

test("writePromptHistory filters sensitive entries before persistence", () => {
  const rootDir = mkdtempSync(`${tmpdir()}/monolito-history-secret-`)
  try {
    writePromptHistory(rootDir, ["safe prompt", ...sensitiveSamples, "another safe prompt"])
    assert.deepEqual(readPromptHistory(rootDir), ["safe prompt", "another safe prompt"])
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})
