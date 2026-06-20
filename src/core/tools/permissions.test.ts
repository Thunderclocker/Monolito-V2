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
const { checkToolPermission, isDestructiveAction, _setTestExistsSync } = await import("../runtime/permissions.ts")

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

test("resolveWorkspacePath resolves tilde home directory paths", async () => {
  const rootDir = "/tmp/fake-root"
  const cwd = "/tmp/fake-cwd"
  const { homedir } = await import("node:os")

  const resHome = await resolveWorkspacePath(rootDir, cwd, "~")
  assert.equal(resHome, homedir())

  const resSub = await resolveWorkspacePath(rootDir, cwd, "~/Downloads")
  assert.equal(resSub, join(homedir(), "Downloads"))
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
  _setTestExistsSync(() => false)
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
    const { existsSync } = await import("node:fs")
    _setTestExistsSync(existsSync)
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test("checkToolPermission bypasses destructive guard when Sudo Mode is active", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "monolito-test-policy-"))
  _setTestExistsSync((path: string) => path === "/etc/sudoers.d/monolito-temp")
  try {
    const context = {
      rootDir,
      sessionId: "test-session-1",
    }
    // With Sudo Mode active, destructive command should bypass destructive_guard and return allow
    const res = await checkToolPermission("Bash", { command: "rm -rf /tmp/foo" }, context)
    assert.equal(res.behavior, "allow")
  } finally {
    const { existsSync } = await import("node:fs")
    _setTestExistsSync(existsSync)
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test("MonolitoV2Runtime emits permission.resolved event on resolvePendingPermission", async () => {
  const { MonolitoV2Runtime } = await import("../runtime/runtime.ts")
  const { ensureSession } = await import("../session/store.ts")
  
  // Create the session in the test DB first to satisfy the foreign key constraint on events table
  ensureSession(testMonolitoRoot, "test-session-id", "Test Session")
  
  const runtime = new MonolitoV2Runtime(testMonolitoRoot)
  
  let receivedEvent: any = null
  runtime.onEvent((event) => {
    receivedEvent = event
  })
  
  let resolvedDecision: any = null
  runtime.registerPendingPermission("test-perm-id", "test-session-id", (decision) => {
    resolvedDecision = decision
  })
  
  const resolved = runtime.resolvePendingPermission("test-perm-id", "allow")
  assert.equal(resolved, true)
  assert.equal(resolvedDecision, "allow")
  assert.ok(receivedEvent)
  assert.equal(receivedEvent.type, "permission.resolved")
  assert.equal(receivedEvent.permissionId, "test-perm-id")
  assert.equal(receivedEvent.decision, "allow")
  assert.equal(receivedEvent.sessionId, "test-session-id")
})
