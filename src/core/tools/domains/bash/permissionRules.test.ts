// Tests para bash/permissionRules.ts

import test from "node:test"
import assert from "node:assert/strict"
import {
  matchWildcardPattern,
  stripAllLeadingEnvVars,
  stripWrappersFromArgv,
  stripCommentLines,
  filterRulesByContentsMatchingInput,
  isReadOnlyCommand,
  hasBinaryHijackVar,
  hasUnquotedCommandSubstitution,
  BINARY_HIJACK_VARS,
} from "./permissionRules.ts"

test("matchWildcardPattern: exact match", () => {
  assert.equal(matchWildcardPattern("npm test", "npm test"), true)
  assert.equal(matchWildcardPattern("npm test", "npm run"), false)
})

test("matchWildcardPattern: * wildcard", () => {
  assert.equal(matchWildcardPattern("npm*", "npm test"), true)
  assert.equal(matchWildcardPattern("npm *", "npm test"), true)
  assert.equal(matchWildcardPattern("git*", "npm test"), false)
})

test("matchWildcardPattern: ? wildcard", () => {
  assert.equal(matchWildcardPattern("r?m", "rim"), true)
  assert.equal(matchWildcardPattern("r?m", "room"), false)
})

test("stripAllLeadingEnvVars: removes FOO=bar", () => {
  const result = stripAllLeadingEnvVars(["FOO=bar", "BAZ=qux", "ls", "-la"])
  assert.deepEqual(result.stripped, ["ls", "-la"])
  assert.equal(result.vars.FOO, "bar")
  assert.equal(result.vars.BAZ, "qux")
})

test("stripAllLeadingEnvVars: no env vars", () => {
  const result = stripAllLeadingEnvVars(["ls", "-la"])
  assert.deepEqual(result.stripped, ["ls", "-la"])
  assert.deepEqual(result.vars, {})
})

test("stripWrappersFromArgv: removes sudo", () => {
  const result = stripWrappersFromArgv(["sudo", "ls"])
  assert.deepEqual(result, ["ls"])
})

test("stripWrappersFromArgv: removes env and assignments", () => {
  const result = stripWrappersFromArgv(["env", "FOO=bar", "ls"])
  assert.deepEqual(result, ["ls"])
})

test("stripWrappersFromArgv: handles timeout with arg", () => {
  const result = stripWrappersFromArgv(["timeout", "30s", "ping", "host"])
  assert.deepEqual(result, ["ping", "host"])
})

test("stripCommentLines: removes # comments", () => {
  const result = stripCommentLines("ls -la # list files")
  assert.equal(result, "ls -la ")
})

test("stripCommentLines: preserves # in quotes", () => {
  const result = stripCommentLines(`echo "hello # world"`)
  assert.match(result, /echo "hello # world"/)
})

test("stripCommentLines: handles multi-line", () => {
  const result = stripCommentLines("ls # comment 1\necho hi # comment 2")
  assert.equal(result, "ls \necho hi ")
})

test("filterRulesByContentsMatchingInput: matches tool glob", () => {
  const rules = [
    { tool: "Bash*", action: "deny" as const },
    { tool: "Read", action: "allow" as const },
  ]
  const filtered = filterRulesByContentsMatchingInput(rules, "Bash", { command: "ls" })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].tool, "Bash*")
})

test("filterRulesByContentsMatchingInput: matches input regex", () => {
  const rules = [
    { tool: "Bash", action: "deny" as const, input: "rm\\s+-rf" },
  ]
  const filtered = filterRulesByContentsMatchingInput(rules, "Bash", { command: "rm -rf /" })
  assert.equal(filtered.length, 1)
})

test("filterRulesByContentsMatchingInput: excludes non-matching input regex", () => {
  const rules = [
    { tool: "Bash", action: "deny" as const, input: "rm\\s+-rf" },
  ]
  const filtered = filterRulesByContentsMatchingInput(rules, "Bash", { command: "ls -la" })
  assert.equal(filtered.length, 0)
})

test("isReadOnlyCommand: ls is read-only", () => {
  assert.equal(isReadOnlyCommand({ argv: ["ls"], hasRedirection: false }), true)
  assert.equal(isReadOnlyCommand({ argv: ["ls", "-la"], hasRedirection: false }), true)
  assert.equal(isReadOnlyCommand({ argv: ["cat", "file"], hasRedirection: false }), true)
  assert.equal(isReadOnlyCommand({ argv: ["grep", "x"], hasRedirection: false }), true)
})

test("isReadOnlyCommand: rm is not", () => {
  assert.equal(isReadOnlyCommand({ argv: ["rm", "file"], hasRedirection: false }), false)
})

test("isReadOnlyCommand: ls with redirection is not", () => {
  assert.equal(isReadOnlyCommand({ argv: ["ls"], hasRedirection: true }), false)
})

test("hasBinaryHijackVar: detects LD_PRELOAD", () => {
  assert.equal(hasBinaryHijackVar({ LD_PRELOAD: "/tmp/x.so" }), true)
  assert.equal(hasBinaryHijackVar({ DYLD_INSERT_LIBRARIES: "/tmp/x" }), true)
  assert.equal(hasBinaryHijackVar({ PATH: "/tmp" }), true)
  assert.equal(hasBinaryHijackVar({ HOME: "/tmp" }), false)
  assert.equal(hasBinaryHijackVar({}), false)
})

test("hasUnquotedCommandSubstitution: detects $()", () => {
  assert.equal(hasUnquotedCommandSubstitution("echo $(date)"), true)
  assert.equal(hasUnquotedCommandSubstitution("echo `date`"), true)
  assert.equal(hasUnquotedCommandSubstitution("echo hello"), false)
})

test("BINARY_HIJACK_VARS matches LD_ and DYLD_", () => {
  assert.match("LD_PRELOAD", BINARY_HIJACK_VARS)
  assert.match("DYLD_FOO", BINARY_HIJACK_VARS)
  assert.match("PATH", BINARY_HIJACK_VARS)
  assert.doesNotMatch("HOME", BINARY_HIJACK_VARS)
})
