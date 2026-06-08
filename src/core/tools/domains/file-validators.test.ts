// Tests para file-validators.ts

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isSettingsFile,
  validateSettingsFileContent,
  findSimilarFiles,
  suggestPathUnderCwd,
} from "./file-validators.ts"

test("isSettingsFile: detects settings.json", () => {
  assert.equal(isSettingsFile("settings.json"), true)
  assert.equal(isSettingsFile("Settings.JSON"), true)
  assert.equal(isSettingsFile("package.json"), true)
  assert.equal(isSettingsFile("tsconfig.json"), true)
})

test("isSettingsFile: non-settings file", () => {
  assert.equal(isSettingsFile("foo.txt"), false)
  assert.equal(isSettingsFile("main.ts"), false)
})

test("validateSettingsFileContent: valid JSON", () => {
  const r = validateSettingsFileContent("settings.json", '{"a": 1}')
  assert.equal(r.valid, true)
})

test("validateSettingsFileContent: invalid JSON", () => {
  const r = validateSettingsFileContent("settings.json", "{ invalid")
  assert.equal(r.valid, false)
  assert.match(r.reason!, /Invalid JSON/)
})

test("validateSettingsFileContent: non-settings file passes through", () => {
  const r = validateSettingsFileContent("foo.txt", "anything goes")
  assert.equal(r.valid, true)
})

test("findSimilarFiles: empty dir", () => {
  const root = mkdtempSync(join(tmpdir(), "monolito-fv-"))
  try {
    const results = findSimilarFiles(join(root, "foo.txt"))
    assert.deepEqual(results, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("findSimilarFiles: finds similar names", () => {
  const root = mkdtempSync(join(tmpdir(), "monolito-fv-"))
  try {
    writeFileSync(join(root, "config.json"), "{}")
    writeFileSync(join(root, "configs.json"), "{}")
    writeFileSync(join(root, "settings.json"), "{}")
    writeFileSync(join(root, "main.txt"), "x")
    const results = findSimilarFiles(join(root, "config.json"))
    assert.ok(results.length > 0, "should find at least configs.json")
    assert.ok(results.some(r => r.includes("configs.json")))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("findSimilarFiles: same extension ranks higher", () => {
  const root = mkdtempSync(join(tmpdir(), "monolito-fv-"))
  try {
    writeFileSync(join(root, "app.ts"), "x")
    writeFileSync(join(root, "app.js"), "x")
    writeFileSync(join(root, "apples.ts"), "x")
    const results = findSimilarFiles(join(root, "app.ts"))
    // apple.ts should rank higher than app.js
    if (results.length >= 2) {
      const appleIdx = results.findIndex(r => r.includes("apples"))
      const jsIdx = results.findIndex(r => r.includes("app.js"))
      assert.ok(appleIdx < jsIdx, `apples.ts should rank before app.js: ${JSON.stringify(results)}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("suggestPathUnderCwd: outside cwd gets joined", () => {
  const result = suggestPathUnderCwd("/etc/passwd", "/home/user")
  assert.equal(result, "/home/user/passwd")
})

test("suggestPathUnderCwd: inside cwd unchanged", () => {
  const result = suggestPathUnderCwd("/home/user/foo.txt", "/home/user")
  assert.equal(result, "/home/user/foo.txt")
})
