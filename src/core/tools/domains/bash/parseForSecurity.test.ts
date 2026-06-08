// Tests para bash/parseForSecurity.ts

import test from "node:test"
import assert from "node:assert/strict"
import {
  parseBashCommand,
  isCommandParseable,
  getCommandNames,
} from "./parseForSecurity.ts"

test("parseBashCommand: simple command", () => {
  const result = parseBashCommand("ls -la")
  assert.equal(result.segments.length, 1)
  assert.deepEqual(result.segments[0].argv, ["ls", "-la"])
  assert.equal(result.segments[0].parseStatus, "ok")
  assert.equal(result.allSegmentsParseOk, true)
})

test("parseBashCommand: pipe chain", () => {
  const result = parseBashCommand("cat file.txt | grep pattern | wc -l")
  assert.equal(result.segments.length, 3)
  assert.deepEqual(result.segments[0].argv, ["cat", "file.txt"])
  assert.deepEqual(result.segments[1].argv, ["grep", "pattern"])
  assert.deepEqual(result.segments[2].argv, ["wc", "-l"])
  assert.equal(result.allSegmentsParseOk, true)
})

test("parseBashCommand: logical AND", () => {
  const result = parseBashCommand("cd /tmp && ls -la")
  assert.equal(result.segments.length, 2)
  assert.equal(result.segments[0].startsWithCd, true)
  assert.equal(result.segments[1].argv[0], "ls")
  assert.equal(result.hasLogicalOperators, true)
})

test("parseBashCommand: strips env var prefix", () => {
  const result = parseBashCommand("FOO=bar BAZ=qux node script.js")
  assert.deepEqual(result.segments[0].argv, ["node", "script.js"])
})

test("parseBashCommand: strips wrappers", () => {
  const result = parseBashCommand("sudo -E ls /etc")
  assert.deepEqual(result.segments[0].wrappers, ["sudo"])
  assert.ok(result.segments[0].argv.includes("ls"))
})

test("parseBashCommand: detects git command", () => {
  const result = parseBashCommand("git status")
  assert.equal(result.segments[0].isGitCommand, true)
})

test("parseBashCommand: detects redirection", () => {
  const result = parseBashCommand("echo hello > /tmp/out.txt")
  assert.equal(result.segments[0].hasRedirection, true)
  assert.equal(result.hasRedirection, true)
})

test("parseBashCommand: detects subshell", () => {
  const result = parseBashCommand("echo $(date)")
  assert.equal(result.segments[0].hasSubshell, true)
})

test("parseBashCommand: handles quotes", () => {
  const result = parseBashCommand('echo "hello world" | grep "hello"')
  assert.equal(result.segments.length, 2)
  assert.deepEqual(result.segments[0].argv, ["echo", "hello world"])
  assert.deepEqual(result.segments[1].argv, ["grep", "hello"])
})

test("parseBashCommand: handles escape", () => {
  const result = parseBashCommand("echo hello\\ world")
  assert.equal(result.segments.length, 1)
  assert.equal(result.allSegmentsParseOk, true)
})

test("parseBashCommand: backgrounding", () => {
  const result = parseBashCommand("npm start &")
  assert.equal(result.hasBackground, true)
  assert.equal(result.segments.length, 1)
})

test("parseBashCommand: complex command", () => {
  // Simplified — full redirect handling is best-effort
  const result = parseBashCommand("cd /tmp && FOO=bar sudo -E npm test --coverage | tee out.log")
  // Find the segment with sudo
  const sudoSeg = result.segments.find(s => s.wrappers.includes("sudo"))
  assert.ok(sudoSeg, "expected a segment with sudo wrapper")
  // First segment should be the cd
  assert.equal(result.segments[0].startsWithCd, true)
})

test("isCommandParseable: ok for simple", () => {
  assert.equal(isCommandParseable(parseBashCommand("ls -la")), true)
})

test("getCommandNames: returns first token of each segment", () => {
  const result = parseBashCommand("ls | grep x | wc")
  const names = getCommandNames(result)
  assert.deepEqual(names, ["ls", "grep", "wc"])
})
