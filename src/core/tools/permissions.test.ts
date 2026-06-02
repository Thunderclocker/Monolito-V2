import test, { after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Set isolated environment root before importing Monolito core modules
const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-test-root-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

// Dynamically import the core modules so they pick up the environment variable
const { getTool } = await import("./registry.ts")
const { readConfigWing } = await import("../session/store.ts")

after(() => {
  rmSync(testMonolitoRoot, { recursive: true, force: true })
})

// Simular el ToolContext y el Runtime mínimos para el test
class MockRuntime {
  public rootDir: string
  public lastEvent: any = null
  private pendingPermissions = new Map<string, { resolve: (decision: "allow" | "deny" | "ask") => void }>()
  public autoRespondDecision: "allow" | "deny" | "ask" | null = null

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  registerPendingPermission(permissionId: string, resolve: (decision: "allow" | "deny" | "ask") => void) {
    this.pendingPermissions.set(permissionId, { resolve })
    
    // Autoresponder de forma asíncrona si hay un decision configurada
    if (this.autoRespondDecision !== null) {
      const decision = this.autoRespondDecision
      setTimeout(() => {
        this.resolvePendingPermission(permissionId, decision)
      }, 5)
    }
  }

  resolvePendingPermission(permissionId: string, decision: "allow" | "deny" | "ask") {
    const pending = this.pendingPermissions.get(permissionId)
    if (pending) {
      pending.resolve(decision)
      this.pendingPermissions.delete(permissionId)
      return true
    }
    return false
  }

  emit(event: any) {
    this.lastEvent = event
  }
}

function createRootDir() {
  return mkdtempSync(join(tmpdir(), "monolito-permissions-test-"))
}

function cleanupRootDir(rootDir: string) {
  rmSync(rootDir, { recursive: true, force: true })
}

test("resolveWorkspacePath requests interactive permission when path escapes workspace and allows access if approved", async () => {
  const rootDir = createRootDir()
  const mockRuntime = new MockRuntime(rootDir)
  mockRuntime.autoRespondDecision = "ask" // Permitir una vez sin guardar regla

  const context = {
    rootDir,
    cwd: rootDir,
    sessionId: "test-session",
    runtime: mockRuntime as any,
  }

  const tool = getTool("Read")
  assert.ok(tool)

  const targetPath = resolve("/tmp/monolito-escaped-test-file-1.txt")

  const resultPromise = tool.run({
    path: targetPath,
  }, context)

  // Verificar que se emitió el evento permission.request al runtime
  await new Promise(r => setTimeout(r, 10))
  assert.ok(mockRuntime.lastEvent)
  assert.equal(mockRuntime.lastEvent.type, "permission.request")
  assert.equal(mockRuntime.lastEvent.path, targetPath)

  const result = await resultPromise as string
  const parsed = JSON.parse(result)
  // Debería fallar por inexistencia del archivo (ENOENT), no por denegación de permisos
  assert.equal(parsed.success, false)
  assert.match(parsed.error, /ENOENT|no such file/i)

  cleanupRootDir(rootDir)
})

test("resolveWorkspacePath rejects access if user denies the permission request", async () => {
  const rootDir = createRootDir()
  const mockRuntime = new MockRuntime(rootDir)
  mockRuntime.autoRespondDecision = "deny" // Denegar

  const context = {
    rootDir,
    cwd: rootDir,
    sessionId: "test-session",
    runtime: mockRuntime as any,
  }

  const tool = getTool("Read")
  assert.ok(tool)

  const targetPath = resolve("/tmp/monolito-escaped-test-file-2.txt")

  const result = await tool.run({
    path: targetPath,
  }, context) as string

  const parsed = JSON.parse(result)
  assert.equal(parsed.success, false)
  assert.match(parsed.error, /Permission denied: Path escapes workspace boundaries/)

  cleanupRootDir(rootDir)
})

test("resolveWorkspacePath persists 'allow' always rule inside CONF_POLICY and bypasses future prompts", async () => {
  const rootDir = createRootDir()
  const mockRuntime = new MockRuntime(rootDir)
  mockRuntime.autoRespondDecision = "allow" // Permitir y guardar siempre

  const context = {
    rootDir,
    cwd: rootDir,
    sessionId: "test-session",
    runtime: mockRuntime as any,
  }

  const tool = getTool("Read")
  assert.ok(tool)

  const targetPath = resolve("/tmp/monolito-escaped-test-file-3.txt")

  // Primera ejecución: pedirá permisos y guardará regla "allow"
  const result1 = await tool.run({ path: targetPath }, context) as string
  const parsed1 = JSON.parse(result1)
  assert.equal(parsed1.success, false)
  assert.match(parsed1.error, /ENOENT|no such file/i)

  assert.ok(mockRuntime.lastEvent)
  assert.equal(mockRuntime.lastEvent.type, "permission.request")

  // Comprobar que la regla se guardó en CONF_POLICY
  const policy = readConfigWing(rootDir, "CONF_POLICY")
  const rules = policy?.permissions?.rules || []
  assert.ok(rules.some((rule: any) => rule.action === "allow" && rule.input === targetPath))

  // Reiniciar el mock de eventos
  mockRuntime.lastEvent = null
  mockRuntime.autoRespondDecision = null // No responder automáticamente para verificar que no se llame

  // Segunda ejecución: no debería disparar eventos de solicitud (usa regla directa de CONF_POLICY)
  const result2 = await tool.run({ path: targetPath }, context) as string
  const parsed2 = JSON.parse(result2)
  assert.equal(parsed2.success, false)
  assert.match(parsed2.error, /ENOENT|no such file/i)

  assert.equal(mockRuntime.lastEvent, null) // Bypasseó el prompt
  cleanupRootDir(rootDir)
})
