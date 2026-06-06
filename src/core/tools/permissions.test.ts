import test, { after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Set isolated environment root before importing Monolito core modules
const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-test-root-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

// Dynamically import the core modules so they pick up the environment variable
const { resolveWorkspacePath } = await import("./registry.ts")
const { checkToolPermission, isDestructiveAction } = await import("../runtime/permissions.ts")

after(() => {
  rmSync(testMonolitoRoot, { recursive: true, force: true })
})

test("resolveWorkspacePath resolves any absolute path without prompting", async () => {
  const rootDir = "/tmp/fake-root"
  const cwd = "/tmp/fake-cwd"
  const target = "/etc/passwd"
  const res = await resolveWorkspacePath(rootDir, cwd, target)
  assert.equal(res, resolve("/etc/passwd"))
})

test("isDestructiveAction detects dangerous bash commands", () => {
  const dangerous = [
    "rm -rf /",
    "rm -fr /",
    "rm -Rf /",
    "kill -9 123",
    "killall nginx",
    "systemctl stop nginx",
    "systemctl restart sshd",
    "systemctl disable nginx",
    "dd if=/dev/zero of=/dev/sda",
    "shutdown now",
    "unlink /etc/passwd",
    "shred -vfz /dev/sda",
    "init 0",
    "VAR=val sudo rm -rf /etc",
    ":(){ :|:& };:",
  ]
  for (const cmd of dangerous) {
    const res = isDestructiveAction("Bash", { command: cmd })
    assert.equal(res.destructive, true, `Should detect ${cmd} as destructive`)
    assert.match(res.reason || "", /contains destructive commands/i)
  }
})

test("isDestructiveAction allows safe read-only commands", () => {
  const safe = [
    "ls -la",
    "cat README.md",
    "git status",
    "npm run build",
    "node bin/monolito.js ask",
    // Regression: these used to be false positives
    "echo rm is dangerous",
    "man rm",
    "systemctl reboot",      // legitimate user-initiated reboot
    "systemctl poweroff",    // legitimate user-initiated poweroff
    "systemctl halt",        // legitimate user-initiated halt
    "sudo apt update",
    "apt install nginx",
    "git commit -m fix",
    "echo $HOME",
  ]
  for (const cmd of safe) {
    const res = isDestructiveAction("Bash", { command: cmd })
    assert.equal(res.destructive, false, `Should allow ${cmd} (got reason: ${res.reason})`)
  }
})

test("checkToolPermission returns ask for destructive Bash commands when otherwise allowed", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "monolito-test-policy-"))
  try {
    const context = {
      rootDir,
      sessionId: "test-session-1",
    }
    // With default mode (acceptEdits), rm -rf / should return ask/destructive_guard
    const res = await checkToolPermission("Bash", { command: "rm -rf /tmp/foo" }, context)
    assert.equal(res.behavior, "ask")
    assert.equal(res.source, "destructive_guard")
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})
