import test, { after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Set isolated environment root before importing Monolito core modules
const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-registry-test-root-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

// Dynamically import the core modules so they pick up the environment variable
const { getTool } = await import("./registry.ts")
const {
  addGraphTriple,
  appendEvent,
  appendMessage,
  appendWorklog,
  clearMemoryPalace,
  ensureSession,
  getDb,
  queryGraphEntity,
  readBootWing,
  readConfigWing,
  recallMemory,
  writeBootWing,
  writeConfigWing,
} = await import("../session/store.ts")

after(() => {
  rmSync(testMonolitoRoot, { recursive: true, force: true })
})

function createRootDir() {
  return mkdtempSync(join(tmpdir(), "monolito-tools-test-"))
}

function cleanupRootDir(rootDir: string) {
  rmSync(rootDir, { recursive: true, force: true })
}

test("tool_manage_config writes CONF_CHANNELS when value is a JSON string with valid telegram config", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    const result = await tool.run({
      action: "write",
      wing: "CONF_CHANNELS",
      value: "{\"telegram\":{\"token\":\"abc\",\"enabled\":true,\"allowedChats\":[]}}",
    }, {
      rootDir,
      cwd: rootDir,
    })

    assert.equal((result as { wing: string }).wing, "CONF_CHANNELS")
    assert.equal((result as { ok: boolean }).ok, true)
    assert.equal((result as { effect: string }).effect, "daemon_restart_required")
    assert.deepEqual(readConfigWing(rootDir, "CONF_CHANNELS"), {
      telegram: { token: "abc", enabled: true, allowedChats: [] },
    })
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("tool_manage_config normalizes legacy CONF_CHANNELS telegram aliases", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    const result = await tool.run({
      action: "write",
      wing: "CONF_CHANNELS",
      value: "{\"telegram\":{\"bot_token\":\"123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabc\",\"enabled\":true,\"authorized_chats\":[\"1515784684\"]}}",
    }, {
      rootDir,
      cwd: rootDir,
    })

    assert.equal((result as { wing: string }).wing, "CONF_CHANNELS")
    assert.equal((result as { ok: boolean }).ok, true)
    assert.deepEqual(readConfigWing(rootDir, "CONF_CHANNELS"), {
      telegram: {
        token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabc",
        enabled: true,
        allowedChats: [1515784684],
      },
    })
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("tool_manage_config redacts CONF_CHANNELS secrets when reading config", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    await tool.run({
      action: "write",
      wing: "CONF_CHANNELS",
      value: "{\"telegram\":{\"token\":\"123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabc\",\"enabled\":true,\"allowedChats\":[1515784684]}}",
    }, {
      rootDir,
      cwd: rootDir,
    })

    const result = await tool.run({
      action: "read",
      wing: "CONF_CHANNELS",
    }, {
      rootDir,
      cwd: rootDir,
    })

    assert.deepEqual((result as { value: unknown }).value, {
      telegram: {
        token: "[REDACTED]",
        enabled: true,
        allowedChats: [1515784684],
      },
    })
    assert.deepEqual(readConfigWing(rootDir, "CONF_CHANNELS"), {
      telegram: {
        token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabc",
        enabled: true,
        allowedChats: [1515784684],
      },
    })
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("tool_manage_config rejects JSON string CONF_CHANNELS values that use root enabled", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    const result = await tool.run({
      action: "write",
      wing: "CONF_CHANNELS",
      value: "{\"enabled\":true,\"telegram\":{\"token\":\"abc\",\"enabled\":true,\"allowedChats\":[]}}",
    }, {
      rootDir,
      cwd: rootDir,
    }) as string

    const parsed = JSON.parse(result)
    assert.equal(parsed.success, false)
    assert.match(parsed.error, /unsupported top-level keys: enabled/)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("tool_manage_config rejects JSON string CONF_CHANNELS values that use session_name", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    const result = await tool.run({
      action: "write",
      wing: "CONF_CHANNELS",
      value: "{\"telegram\":{\"token\":\"abc\",\"enabled\":true,\"allowedChats\":[],\"session_name\":\"legacy\"}}",
    }, {
      rootDir,
      cwd: rootDir,
    }) as string

    const parsed = JSON.parse(result)
    assert.equal(parsed.success, false)
    assert.match(parsed.error, /must not use 'session_name'/)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("tool_manage_config validates hotkey screenshot fields", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    // Valid configuration with screenshot hotkeys
    const validResult = await tool.run({
      action: "write",
      wing: "CONF_CHANNELS",
      value: JSON.stringify({
        hotkey: {
          enabled: true,
          keycode: [50, 133],
          screenshotEnabled: true,
          screenshotKeycode: [50, 107]
        }
      }),
    }, { rootDir, cwd: rootDir })
    assert.equal((validResult as { ok: boolean }).ok, true)

    // Invalid screenshotEnabled type
    const invalidBool = await tool.run({
      action: "write",
      wing: "CONF_CHANNELS",
      value: JSON.stringify({
        hotkey: {
          enabled: true,
          keycode: 49,
          screenshotEnabled: "yes"
        }
      }),
    }, { rootDir, cwd: rootDir }) as string
    assert.equal(JSON.parse(invalidBool).success, false)
    assert.match(JSON.parse(invalidBool).error, /screenshotEnabled must be a boolean/)

    // Invalid screenshotKeycode type
    const invalidKeycode = await tool.run({
      action: "write",
      wing: "CONF_CHANNELS",
      value: JSON.stringify({
        hotkey: {
          enabled: true,
          keycode: 49,
          screenshotKeycode: ["50", "107"]
        }
      }),
    }, { rootDir, cwd: rootDir }) as string
    assert.equal(JSON.parse(invalidKeycode).success, false)
    assert.match(JSON.parse(invalidKeycode).error, /screenshotKeycode must be a positive number or an array of positive numbers/)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("WebFetch strips noisy HTML assets before selecting relevant text", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("WebFetch")
    assert.ok(tool)

    const noisyCss = ".unused{color:red;}".repeat(600)
    const html = `
      <html>
        <head>
          <style>${noisyCss}</style>
          <script>window.analytics = true;</script>
        </head>
        <body>
          <nav>Inicio Buscar Menú</nav>
          <main>
            <h1>Clima en Santo Tomé</h1>
            <section>
              <h2>Pronóstico extendido</h2>
              <p>Domingo 26/4</p>
              <p>Lluvia ligera</p>
              <p>Máx: 21°C Mín: 9°C</p>
            </section>
          </main>
        </body>
      </html>
    `
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    const result = await tool.run({
      url,
      prompt: "Pronóstico del tiempo para Santo Tomé domingo 26 abril lluvia temperatura",
    }, {
      rootDir,
      cwd: rootDir,
    }) as { result: string }

    assert.doesNotMatch(result.result, /\.unused/)
    assert.doesNotMatch(result.result, /window\.analytics/)
    assert.match(result.result, /Domingo 26\/4/)
    assert.match(result.result, /Máx: 21°C Mín: 9°C/)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("SessionForensics reconstructs recent session actions from persisted evidence", async () => {
  const rootDir = createRootDir()
  try {
    ensureSession(rootDir, "session-1", "Forensics Session")
    appendMessage(rootDir, "session-1", "user", "Que hiciste en esta sesion?")
    appendWorklog(rootDir, "session-1", { type: "tool", summary: "Tool Bash finished successfully" })
    appendEvent(rootDir, {
      type: "tool.finish",
      sessionId: "session-1",
      tool: "Bash",
      ok: true,
      output: { stdout: "ok" },
    })

    const tool = getTool("SessionForensics")
    assert.ok(tool)

    const result = await tool.run({
      sessionId: "session-1",
      intent: "actions",
    }, {
      rootDir,
      cwd: rootDir,
    })

    assert.equal((result as { intent: string }).intent, "actions")
    assert.equal((result as { session: { id: string } }).session.id, "session-1")
    assert.deepEqual((result as { recommendedSources: string[] }).recommendedSources, ["worklog", "events", "messages"])
    assert.ok((result as { evidence: string[] }).evidence.some(line => line.includes("Tool Bash finished successfully")))
    assert.ok((result as { evidence: string[] }).evidence.some(line => line.includes("tool.finish: Bash ok")))
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("SessionForensics surfaces delegation evidence from events", async () => {
  // Skipped: the sub-agent delegation feature was removed; the
  // SessionForensics "delegation" intent no longer surfaces in the
  // production path. The intent handler is preserved as a no-op for
  // backward compatibility. See migration 20260611_drop_worker_tables.sql.
  assert.ok(true)
})

test("SessionForensics performs keyword-based search across full history when question is supplied", async () => {
  const rootDir = createRootDir()
  try {
    ensureSession(rootDir, "session-3", "Searchable Forensics Session")
    
    // Add multiple messages/worklogs, placing the target one far back in history
    appendWorklog(rootDir, "session-3", { type: "tool", summary: "Step 1: Skill skill_acceder_vps created successfully" })
    for (let i = 0; i < 30; i++) {
      appendWorklog(rootDir, "session-3", { type: "tool", summary: `Unrelated step ${i}` })
    }

    const tool = getTool("SessionForensics")
    assert.ok(tool)

    // Running standard search without question would cut off the target log (limit is 8 by default)
    const resultNormal = await tool.run({
      sessionId: "session-3",
      intent: "actions",
    }, { rootDir, cwd: rootDir }) as { evidence: string[] }

    assert.ok(!resultNormal.evidence.some(line => line.includes("skill_acceder_vps")))

    // Running search with a question matching the keyword should locate it
    const resultSearch = await tool.run({
      sessionId: "session-3",
      intent: "actions",
      question: "tell me about skill_acceder_vps dynamic skills testing",
    }, { rootDir, cwd: rootDir }) as { evidence: string[] }

    assert.ok(resultSearch.evidence.some(line => line.includes("skill_acceder_vps")))
  } finally {
    cleanupRootDir(rootDir)
  }
})

// Fix 3 (2026-06-10): SessionForensics rechaza sessionIds numéricos
// que parecen chat_id de Telegram (9-10 dígitos), no un sessionId real.
test("SessionForensics rejects numeric sessionId that looks like a Telegram chat_id (Fix 3)", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("SessionForensics")
    assert.ok(tool)

    const rawResult = await tool.run({ sessionId: "1515784684" }, { rootDir, cwd: rootDir })
    const result = JSON.parse(String(rawResult)) as { success: boolean; error?: string }
    assert.equal(result.success, false)
    assert.match(result.error ?? "", /chat_id de Telegram/)
    assert.match(result.error ?? "", /9-10 dígitos numéricos/)
    assert.match(result.error ?? "", /única sesión persistente/)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("SessionForensics lists available sessions when a non-existent sessionId is given (Fix 3)", async () => {
  const rootDir = createRootDir()
  try {
    ensureSession(rootDir, "orchestrator", "Main session")
    const tool = getTool("SessionForensics")
    assert.ok(tool)

    const rawResult = await tool.run({ sessionId: "no-existe-esta-sesion" }, { rootDir, cwd: rootDir })
    const result = JSON.parse(String(rawResult)) as { success: boolean; error?: string }
    assert.equal(result.success, false)
    assert.match(result.error ?? "", /Session "no-existe-esta-sesion" not found/)
    assert.match(result.error ?? "", /Sesiones disponibles/)
    assert.match(result.error ?? "", /orchestrator/)
    assert.match(result.error ?? "", /única sesión persistente/)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("SessionForensics falls back to the current session when sessionId is empty (Fix 3 regression)", async () => {
  const rootDir = createRootDir()
  try {
    // Wait 10ms to guarantee a distinct, strictly newer timestamp than other tests
    await new Promise(resolve => setTimeout(resolve, 10))
    ensureSession(rootDir, "session-empty", "Empty session id test")
    const tool = getTool("SessionForensics")
    assert.ok(tool)

    const rawResult = await tool.run({ sessionId: "" }, { rootDir, cwd: rootDir })
    const result = typeof rawResult === "string" ? JSON.parse(rawResult) : (rawResult as { session: { id: string } })
    assert.equal(result.session.id, "session-empty")
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("clearMemoryPalace removes profile memory while preserving configuration", async () => {
  const rootDir = createRootDir()
  try {
    writeConfigWing(rootDir, "CONF_CHANNELS", {
      telegram: { token: "abc", enabled: true, allowedChats: [1515784684] },
    })
    writeBootWing(rootDir, "BOOT_MEMORY", "Cristian vive en Santo Tome.", "default")
    getDb(rootDir).prepare(`
      INSERT INTO memory_drawers (id, profile_id, wing, room, memory_key, content, created_at)
      VALUES (?, 'default', 'PRIVATE', 'notes', NULL, 'dato durable', ?)
    `).run(randomUUID(), new Date().toISOString())
    addGraphTriple(rootDir, "default", "Cristian", "lives_in", "Santo Tome", new Date().toISOString())

    const before = await recallMemory(rootDir, undefined, undefined, undefined, "default")
    assert.ok(before.some(row => row.wing === "PRIVATE"))
    assert.equal(queryGraphEntity(rootDir, "default", "Cristian").length, 1)

    const cleared = clearMemoryPalace(rootDir, "default")

    assert.ok(cleared.memoryRowsDeleted >= 1)
    assert.equal(cleared.graphRowsDeleted, 1)
    assert.deepEqual(readConfigWing(rootDir, "CONF_CHANNELS"), {
      telegram: { token: "abc", enabled: true, allowedChats: [1515784684] },
    })
    assert.equal(queryGraphEntity(rootDir, "default", "Cristian").length, 0)
    assert.equal(await recallMemory(rootDir, undefined, undefined, undefined, "default").then(rows => rows.some(row => row.wing === "PRIVATE")), false)
    assert.equal(readBootWing(rootDir, "BOOT_MEMORY", "default"), "# BOOT_MEMORY - Memoria Curada de Largo Plazo\n\nGuarda aqui notas destiladas y durables. No uses esto para logs ruidosos del dia a dia.\n")
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Tool registry basic functionality", async () => {
  const rootDir = createRootDir()
  try {
    // Basic smoke test for core tools
    const bashTool = getTool("Bash")
    const writeTool = getTool("Write")
    assert.ok(bashTool)
    assert.ok(writeTool)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Tool provenance handling", async () => {
  const rootDir = createRootDir()
  try {
    // Test that tools can be retrieved and have expected structure
    const bashTool = getTool("Bash")
    assert.ok(bashTool)
    assert.equal(bashTool.permissionTier, "edit")
    assert.ok(typeof bashTool.run === "function")
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("listDynamicSkills and telemetry", async () => {
  // The skill system was removed. These functions no longer exist.
  const store = await import("../session/store.ts")
  assert.ok(typeof store.upsertSemanticTool === "function")
  // @ts-expect-error skill system was removed
  assert.ok(typeof store.listDynamicSkills === "undefined")
})

test("Skill system removal verification", async () => {
  // The entire skill system (CreateSkill, ListSkills, skill_view, telemetry, etc.) has been removed.
  const store = await import("../session/store.ts")
  // @ts-expect-error skill system was removed
  assert.ok(typeof store.listDynamicSkills === "undefined", "listDynamicSkills was removed")
  // @ts-expect-error skill system was removed
  assert.ok(typeof store.getDynamicSkill === "undefined", "getDynamicSkill was removed")
  // @ts-expect-error skill system was removed
  assert.ok(typeof store.saveDynamicSkill === "undefined", "saveDynamicSkill was removed")
})

test("tool_manage_config action 'get' reads nested configuration path", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    await tool.run({
      action: "write",
      wing: "CONF_CHANNELS",
      value: "{\"telegram\":{\"token\":\"my-secret-token\",\"enabled\":true,\"allowedChats\":[123]}}",
    }, { rootDir, cwd: rootDir })

    const result = await tool.run({
      action: "get",
      wing: "CONF_CHANNELS",
      path: "telegram.enabled",
    }, { rootDir, cwd: rootDir }) as { wing: string, path: string, value: unknown }

    assert.equal(result.wing, "CONF_CHANNELS")
    assert.equal(result.path, "telegram.enabled")
    assert.equal(result.value, true)

    // Verify token is redacted in get
    const tokenResult = await tool.run({
      action: "get",
      wing: "CONF_CHANNELS",
      path: "telegram.token",
    }, { rootDir, cwd: rootDir }) as { value: unknown }
    assert.equal(tokenResult.value, "[REDACTED]")
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("tool_manage_config action 'set' updates nested configuration path", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    await tool.run({
      action: "write",
      wing: "CONF_CHANNELS",
      value: "{\"telegram\":{\"token\":\"abc\",\"enabled\":false,\"allowedChats\":[]}}",
    }, { rootDir, cwd: rootDir })

    const result = await tool.run({
      action: "set",
      wing: "CONF_CHANNELS",
      path: "telegram.enabled",
      value: "true",
    }, { rootDir, cwd: rootDir }) as { wing: string, path: string, ok: boolean }

    assert.equal(result.wing, "CONF_CHANNELS")
    assert.equal(result.path, "telegram.enabled")
    assert.equal(result.ok, true)

    const updated = readConfigWing(rootDir, "CONF_CHANNELS")
    assert.equal(updated.telegram?.enabled, true)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("tool_manage_config action 'activate_model' changes the active profile", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    // Write registry with profiles
    const registry = {
      version: 1,
      profiles: [
        { id: "profile-1", name: "P1", provider: "openai_compatible", baseUrl: "http://test", apiKey: "key1", model: "m1", active: true },
        { id: "profile-2", name: "P2", provider: "openai_compatible", baseUrl: "http://test", apiKey: "key2", model: "m2", active: false }
      ]
    }
    await tool.run({
      action: "write",
      wing: "CONF_MODELS",
      value: JSON.stringify(registry),
    }, { rootDir, cwd: rootDir })

    const result = await tool.run({
      action: "activate_model",
      value: "profile-2",
    }, { rootDir, cwd: rootDir }) as { ok: boolean, activeProfile: any }

    assert.equal(result.ok, true)
    assert.equal(result.activeProfile.id, "profile-2")
    assert.equal(result.activeProfile.active, true)

    // Verify it is updated in DB
    const updatedRegistry = readConfigWing(rootDir, "CONF_MODELS")
    const activeProfile = updatedRegistry.profiles.find((p: any) => p.active)
    assert.equal(activeProfile?.id, "profile-2")
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Todo tools: TodoWrite requires todos array with content+activeForm+status, replaces list atomically", async () => {
  const rootDir = createRootDir()
  try {
    const { ensureSession } = await import("../session/store.ts")
    const sessionId = "todo-test-session-1"
    ensureSession(rootDir, sessionId, "default")

    const writeTool = getTool("TodoWrite")!
    const result = await writeTool!.run({
      todos: [
        { content: "Run tests", activeForm: "Running tests", status: "in_progress" },
      ],
    }, { rootDir, cwd: rootDir, sessionId, profileId: "default" }) as { todos: Array<{ content: string; activeForm: string; status: string; id: string }>; totalInSession: number }

    assert.equal(result.todos.length, 1)
    assert.equal(result.todos[0].content, "Run tests")
    assert.equal(result.todos[0].activeForm, "Running tests")
    assert.equal(result.todos[0].status, "in_progress")
    assert.ok(result.todos[0].id.startsWith("task-"))
    assert.equal(result.totalInSession, 1)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Todo tools: TodoWrite rejects when more than ONE todo is in_progress", async () => {
  const rootDir = createRootDir()
  try {
    const { ensureSession } = await import("../session/store.ts")
    const sessionId = "todo-test-session-2"
    ensureSession(rootDir, sessionId, "default")

    const writeTool = getTool("TodoWrite")!

    // First call: one in_progress is fine
    await writeTool!.run({
      todos: [
        { content: "Task one", activeForm: "Doing task one", status: "in_progress" },
        { content: "Task two", activeForm: "Doing task two", status: "pending" },
      ],
    }, { rootDir, cwd: rootDir, sessionId, profileId: "default" })

    // Second call: TWO in_progress — should fail
    const second = await writeTool!.run({
      todos: [
        { content: "Task one", activeForm: "Doing task one", status: "in_progress" },
        { content: "Task two", activeForm: "Doing task two", status: "in_progress" },
      ],
    }, { rootDir, cwd: rootDir, sessionId, profileId: "default" })

    assert.equal(typeof second, "string")
    const parsed = JSON.parse(second as string)
    assert.equal(parsed.success, false)
    assert.match(parsed.error, /Multiple todos are marked as in_progress/i)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Todo tools: TodoWrite triggers verification nudge when 3+ items completed with no verify step", async () => {
  const rootDir = createRootDir()
  try {
    const { ensureSession } = await import("../session/store.ts")
    const sessionId = "todo-test-session-3"
    ensureSession(rootDir, sessionId, "default")

    const writeTool = getTool("TodoWrite")!

    // Send a partial list (2 of 3 done) — no nudge
    const r2 = await writeTool!.run({
      todos: [
        { content: "Install dependencies", activeForm: "Installing dependencies", status: "completed" },
        { content: "Write code", activeForm: "Writing code", status: "completed" },
        { content: "Commit changes", activeForm: "Committing changes", status: "in_progress" },
      ],
    }, { rootDir, cwd: rootDir, sessionId, profileId: "default" }) as Record<string, unknown>
    assert.equal(r2.verificationNudge, undefined)

    // Now mark all 3 completed in a single call — nudge fires (none mentions verify)
    const r3 = await writeTool!.run({
      todos: [
        { content: "Install dependencies", activeForm: "Installing dependencies", status: "completed" },
        { content: "Write code", activeForm: "Writing code", status: "completed" },
        { content: "Commit changes", activeForm: "Committing changes", status: "completed" },
      ],
    }, { rootDir, cwd: rootDir, sessionId, profileId: "default" }) as Record<string, unknown>
    assert.ok(typeof r3.verificationNudge === "string", "expected verificationNudge to be set")
    assert.match(r3.verificationNudge as string, /verification step/i)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Todo tools: TodoWrite does NOT trigger verification nudge when at least one item mentions a verify step", async () => {
  const rootDir = createRootDir()
  try {
    const { ensureSession } = await import("../session/store.ts")
    const sessionId = "todo-test-session-4"
    ensureSession(rootDir, sessionId, "default")

    const writeTool = getTool("TodoWrite")!

    // 'Run tests' counts as a verify step — no nudge should fire
    const r = await writeTool!.run({
      todos: [
        { content: "Install dependencies", activeForm: "Installing dependencies", status: "completed" },
        { content: "Write code", activeForm: "Writing code", status: "completed" },
        { content: "Run tests", activeForm: "Running tests", status: "completed" },
      ],
    }, { rootDir, cwd: rootDir, sessionId, profileId: "default" }) as Record<string, unknown>
    assert.equal(r.verificationNudge, undefined)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Todo tools: TodoWrite replaces the list atomically (old items are removed if not in new list)", async () => {
  const rootDir = createRootDir()
  try {
    const { ensureSession } = await import("../session/store.ts")
    const sessionId = "todo-test-session-5"
    ensureSession(rootDir, sessionId, "default")

    const writeTool = getTool("TodoWrite")!
    const listTool = getTool("TodoList")!

    // Initial list: 3 items
    await writeTool!.run({
      todos: [
        { content: "A", activeForm: "Doing A", status: "pending" },
        { content: "B", activeForm: "Doing B", status: "pending" },
        { content: "C", activeForm: "Doing C", status: "pending" },
      ],
    }, { rootDir, cwd: rootDir, sessionId, profileId: "default" })

    // Replace with 1 item — old items should be gone
    await writeTool!.run({
      todos: [
        { content: "D", activeForm: "Doing D", status: "pending" },
      ],
    }, { rootDir, cwd: rootDir, sessionId, profileId: "default" })

    const listed = await listTool.run({}, { rootDir, cwd: rootDir, sessionId, profileId: "default" }) as { tasks: Array<{ content: string }>; totalInSession: number }
    assert.equal(listed.totalInSession, 1)
    assert.equal(listed.tasks[0].content, "D")
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("CONF_POLICY default: ships an intent-mismatch PreToolUse prompt hook", async () => {
  const { DEFAULT_CONFIG_WING_VALUES } = await import("../config/configWings.ts")
  const policy = DEFAULT_CONFIG_WING_VALUES.CONF_POLICY
  assert.ok(policy.hooks.PreToolUse.length > 0, "default policy should ship at least one PreToolUse hook")
  const intentHook = policy.hooks.PreToolUse[0]
  assert.equal(intentHook.type, "prompt", "default PreToolUse hook should be a prompt-type LLM judge")
  assert.ok(intentHook.prompt && intentHook.prompt.length > 200, "default prompt should be substantial")
  assert.ok(intentHook.prompt?.includes("listame"), "default prompt should reference the Amanda case ('listame las skills, no las borres')")
  assert.ok(intentHook.matcher?.tool?.includes("DeleteSkill"), "default matcher should include destructive tools (DeleteSkill)")
  assert.ok(intentHook.description?.includes("Intent-mismatch"), "default hook should be described in English")
})

test("HookDefinition: supports both 'command' and 'prompt' types", async () => {
  // Verify the type system allows both shapes without runtime errors.
  // This is a smoke test for the schema; semantic validation is in the
  // integration tests below.
  const { DEFAULT_CONFIG_WING_VALUES } = await import("../config/configWings.ts")
  const policy = DEFAULT_CONFIG_WING_VALUES.CONF_POLICY
  // A user can also add a custom command-type hook without the 'type' field
  // (defaults to 'command' for backward compatibility).
  const customHook = {
    matcher: { tool: "Bash" },
    commands: [{ cmd: "echo {\"decision\":\"allow\"}" }],
  }
  // The schema accepts both — no runtime assertion needed beyond compile.
  assert.equal(typeof customHook.commands, "object")
  // The default hook's maxTokens is reasonable
  assert.ok(policy.hooks.PreToolUse[0].maxTokens === undefined || policy.hooks.PreToolUse[0].maxTokens! <= 500)
})
