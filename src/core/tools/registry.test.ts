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
      vision: {
        managed: true,
        autoDeploy: true,
        port: 11435,
        containerName: "monolito-vision-moondream",
        model: "moondream",
      },
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
      vision: {
        managed: true,
        autoDeploy: true,
        port: 11435,
        containerName: "monolito-vision-moondream",
        model: "moondream",
      },
    })
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("tool_manage_config writes CONF_CHANNELS with vision config", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    const result = await tool.run({
      action: "write",
      wing: "CONF_CHANNELS",
      value: "{\"telegram\":{\"token\":\"abc\",\"enabled\":true,\"allowedChats\":[]},\"vision\":{\"managed\":true,\"autoDeploy\":true,\"port\":11435,\"containerName\":\"monolito-vision-moondream\",\"model\":\"moondream\"}}",
    }, {
      rootDir,
      cwd: rootDir,
    })

    assert.equal((result as { wing: string }).wing, "CONF_CHANNELS")
    assert.equal((result as { ok: boolean }).ok, true)
    assert.deepEqual(readConfigWing(rootDir, "CONF_CHANNELS"), {
      telegram: { token: "abc", enabled: true, allowedChats: [] },
      vision: {
        managed: true,
        autoDeploy: true,
        port: 11435,
        containerName: "monolito-vision-moondream",
        model: "moondream",
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
      vision: {
        managed: true,
        autoDeploy: true,
        port: 11435,
        containerName: "monolito-vision-moondream",
        model: "moondream",
      },
    })
    assert.deepEqual(readConfigWing(rootDir, "CONF_CHANNELS"), {
      telegram: {
        token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabc",
        enabled: true,
        allowedChats: [1515784684],
      },
      vision: {
        managed: true,
        autoDeploy: true,
        port: 11435,
        containerName: "monolito-vision-moondream",
        model: "moondream",
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
  const rootDir = createRootDir()
  try {
    ensureSession(rootDir, "session-2", "Delegation Session")
    appendEvent(rootDir, {
      type: "tool.start",
      sessionId: "session-2",
      tool: "delegate_background_task",
      input: { task_instruction: "investigate" },
    })
    appendEvent(rootDir, {
      type: "agent.background.completed",
      sessionId: "session-2",
      agentId: "agent-123",
      status: "completed",
      result: "done",
    })

    const tool = getTool("SessionForensics")
    assert.ok(tool)

    const result = await tool.run({
      sessionId: "session-2",
      intent: "delegation",
    }, {
      rootDir,
      cwd: rootDir,
    })

    assert.equal((result as { intent: string }).intent, "delegation")
    assert.match((result as { summary: string }).summary, /evidencia operativa de delegaci/i)
    assert.ok((result as { evidence: string[] }).evidence.some(line => line.includes("delegate_background_task")))
    assert.ok((result as { evidence: string[] }).evidence.some(line => line.includes("agent.background.completed")))
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

test("Dynamic Skills System lifecycle: CreateSkill, ListSkills, skill_view, and DeleteSkill", async () => {
  const rootDir = createRootDir()
  try {
    const createTool = getTool("CreateSkill")
    const listTool = getTool("ListSkills")
    const deleteTool = getTool("DeleteSkill")
    const viewTool = getTool("skill_view")
    assert.ok(createTool)
    assert.ok(listTool)
    assert.ok(deleteTool)
    assert.ok(viewTool)

    // 1. Create a dynamic skill
    const createResult = await createTool.run({
      name: "skill_test_hello",
      description: "Outputs a welcome message",
      guide: "# Welcome SOP\n1. Say hello\n2. Enjoy!",
      requiresTools: ["Bash", "VisionAnalyze"]
    }, {
      rootDir,
      cwd: rootDir
    }) as { ok: boolean }

    assert.equal(createResult.ok, true)

    // 2. List skills
    const listResult = await listTool.run({}, { rootDir, cwd: rootDir }) as string
    assert.match(listResult, /skill_test_hello/)
    assert.match(listResult, /Outputs a welcome message/)
    assert.match(listResult, /Bash, VisionAnalyze/)

    // 3. View dynamic skill guide using skill_view
    const viewResult = await viewTool.run({ name: "skill_test_hello" }, { rootDir, cwd: rootDir }) as string
    assert.match(viewResult, /Welcome SOP/)
    assert.match(viewResult, /Say hello/)

    // 4. Retrieve dynamic skill from store
    const { getDynamicSkill } = await import("../session/store.ts")
    const skill = getDynamicSkill(rootDir, "skill_test_hello")
    assert.ok(skill)
    assert.equal(skill.guide, "# Welcome SOP\n1. Say hello\n2. Enjoy!")
    assert.deepEqual(skill.requiresTools, ["Bash", "VisionAnalyze"])

    // 5. Delete the skill
    const deleteResult = await deleteTool.run({ name: "skill_test_hello" }, { rootDir, cwd: rootDir }) as { ok: boolean }
    assert.equal(deleteResult.ok, true)

    // 6. Verify it is deleted
    const listAfterDelete = await listTool.run({}, { rootDir, cwd: rootDir }) as string
    if (listAfterDelete !== "No hay skills dinámicos registrados en este momento.") {
      assert.ok(!listAfterDelete.includes("skill_test_hello"))
    }
  } finally {
    cleanupRootDir(rootDir)
  }
})

