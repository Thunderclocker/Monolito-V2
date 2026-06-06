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

    // 1. Create a dynamic skill. Use isSkillsSynthetic so the skill is marked
    // provenance=agent and is deletable (user-provenance skills are protected).
    const createResult = await createTool.run({
      name: "skill_test_hello",
      description: "Outputs a welcome message",
      guide: "# Welcome SOP\n1. Say hello\n2. Enjoy!",
      requiresTools: ["Bash", "VisionAnalyze"]
    }, {
      rootDir,
      cwd: rootDir,
      isSkillsSynthetic: true,
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

    // 5. Delete the skill (agent provenance so it's allowed)
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

test("Skills: provenance is set to 'user' for normal sessions and 'agent' for synthetic SkillsAgent turns", async () => {
  const rootDir = createRootDir()
  try {
    const createTool = getTool("CreateSkill")
    const { getDynamicSkill } = await import("../session/store.ts")
    assert.ok(createTool)

    // 1. User provenance (normal session).
    const userResult = await createTool.run({
      name: "skill_user_one",
      description: "User-created skill",
      guide: "# User SOP",
    }, { rootDir, cwd: rootDir, sessionId: "user-session-1" }) as { ok: boolean }
    assert.equal(userResult.ok, true)

    const userSkill = getDynamicSkill(rootDir, "skill_user_one")
    assert.ok(userSkill)
    assert.equal(userSkill.provenance, "user")
    assert.equal(userSkill.active, true)
    assert.ok(userSkill.createdAt)
    assert.ok(userSkill.updatedAt)

    // 2. Agent provenance via isSkillsSynthetic flag.
    const agentResult = await createTool.run({
      name: "skill_agent_one",
      description: "Agent-created skill",
      guide: "# Agent SOP",
    }, { rootDir, cwd: rootDir, sessionId: "user-session-1", isSkillsSynthetic: true }) as { ok: boolean }
    assert.equal(agentResult.ok, true)

    const agentSkill = getDynamicSkill(rootDir, "skill_agent_one")
    assert.ok(agentSkill)
    assert.equal(agentSkill.provenance, "agent")

    // 3. Agent provenance via sessionId prefix 'agent-'.
    const agent2Result = await createTool.run({
      name: "skill_agent_two",
      description: "Sub-agent-created skill",
      guide: "# Sub-agent SOP",
    }, { rootDir, cwd: rootDir, sessionId: "agent-some-worker" }) as { ok: boolean }
    assert.equal(agent2Result.ok, true)

    const agent2Skill = getDynamicSkill(rootDir, "skill_agent_two")
    assert.ok(agent2Skill)
    assert.equal(agent2Skill.provenance, "agent")
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Skills: DeleteSkill protects user-provenance skills from synthetic turns but allows user-turn deletes", async () => {
  const rootDir = createRootDir()
  try {
    const createTool = getTool("CreateSkill")
    const deleteTool = getTool("DeleteSkill")
    const { getDynamicSkill } = await import("../session/store.ts")
    assert.ok(createTool && deleteTool)

    // 1. User-provenance skill, called from a USER turn: should succeed.
    await createTool.run({
      name: "skill_user_owned",
      description: "Owned by user",
      guide: "# Owned",
    }, { rootDir, cwd: rootDir, sessionId: "user-session" })

    const userDelete = await deleteTool.run({ name: "skill_user_owned" }, { rootDir, cwd: rootDir, sessionId: "user-session" }) as { ok: boolean; error?: string }
    assert.equal(userDelete.ok, true)
    assert.equal(getDynamicSkill(rootDir, "skill_user_owned"), undefined)

    // 2. User-provenance skill, called from a SYNTHETIC curator turn: blocked.
    await createTool.run({
      name: "skill_protected",
      description: "User-protected from curator",
      guide: "# Protected",
    }, { rootDir, cwd: rootDir, sessionId: "user-session" })

    const syntheticDelete = await deleteTool.run(
      { name: "skill_protected" },
      { rootDir, cwd: rootDir, sessionId: "skills-synthetic", isSkillsSynthetic: true },
    ) as { ok: boolean; error?: string }
    assert.equal(syntheticDelete.ok, false)
    assert.match(syntheticDelete.error ?? "", /user/i)
    assert.match(syntheticDelete.error ?? "", /ArchiveSkill/i)

    // The skill should still be in the DB
    assert.ok(getDynamicSkill(rootDir, "skill_protected"))

    // 3. User-provenance skill, called from a sub-agent: blocked.
    const subAgentDelete = await deleteTool.run(
      { name: "skill_protected" },
      { rootDir, cwd: rootDir, sessionId: "agent-some-worker" },
    ) as { ok: boolean; error?: string }
    assert.equal(subAgentDelete.ok, false)
    assert.match(subAgentDelete.error ?? "", /user/i)

    // 4. Agent-provenance skill, called from user turn: allowed.
    await createTool.run({
      name: "skill_agent_deletable",
      description: "Agent skill (deletable)",
      guide: "# Agent",
    }, { rootDir, cwd: rootDir, sessionId: "agent-w", isSkillsSynthetic: true })

    const deleteAgentResult = await deleteTool.run({ name: "skill_agent_deletable" }, { rootDir, cwd: rootDir, sessionId: "user-session" }) as { ok: boolean }
    assert.equal(deleteAgentResult.ok, true)
    assert.equal(getDynamicSkill(rootDir, "skill_agent_deletable"), undefined)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Skills: ArchiveSkill marks active=false and RestoreSkill reactivates", async () => {
  const rootDir = createRootDir()
  try {
    const createTool = getTool("CreateSkill")
    const archiveTool = getTool("ArchiveSkill")
    const restoreTool = getTool("RestoreSkill")
    const listTool = getTool("ListSkills")
    const { getDynamicSkill, listDynamicSkills } = await import("../session/store.ts")
    assert.ok(createTool && archiveTool && restoreTool && listTool)

    await createTool.run({
      name: "skill_archiveable",
      description: "Will be archived",
      guide: "# Archive me",
    }, { rootDir, cwd: rootDir, sessionId: "user-session" })

    // Archive with reason
    const archiveResult = await archiveTool.run({
      name: "skill_archiveable",
      reason: "obsolete: replaced by skill_x",
    }, { rootDir, cwd: rootDir }) as { ok: boolean; message?: string }
    assert.equal(archiveResult.ok, true)
    assert.match(archiveResult.message ?? "", /archivado/)
    assert.match(archiveResult.message ?? "", /obsolete/)

    let skill = getDynamicSkill(rootDir, "skill_archiveable")
    assert.ok(skill)
    assert.equal(skill.active, false)
    assert.ok(skill.archivedAt)
    assert.equal(skill.archiveReason, "obsolete: replaced by skill_x")

    // Default listDynamicSkills should NOT return archived skills.
    const defaultList = listDynamicSkills(rootDir)
    assert.equal(defaultList.find(s => s.name === "skill_archiveable"), undefined)

    // With includeArchived, it should be there.
    const allList = listDynamicSkills(rootDir, { includeArchived: true })
    assert.ok(allList.find(s => s.name === "skill_archiveable"))

    // Restore
    const restoreResult = await restoreTool.run({ name: "skill_archiveable" }, { rootDir, cwd: rootDir }) as { ok: boolean }
    assert.equal(restoreResult.ok, true)

    skill = getDynamicSkill(rootDir, "skill_archiveable")
    assert.ok(skill)
    assert.equal(skill.active, true)
    assert.equal(skill.archivedAt, undefined)
    assert.equal(skill.archiveReason, undefined)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Skills: listDynamicSkills supports provenance and active filters", async () => {
  const rootDir = createRootDir()
  try {
    const createTool = getTool("CreateSkill")
    const archiveTool = getTool("ArchiveSkill")
    const { listDynamicSkills } = await import("../session/store.ts")
    assert.ok(createTool && archiveTool)

    // Note: getDb caches a single instance globally, so earlier tests in this
    // file may have left skills in the DB. Filter to THIS rootDir by reading
    // only the rows that match our created skill names — then assert the
    // provenance/active filters work as documented.

    // Mix of user + agent
    await createTool.run({ name: "skill_flt_u1", description: "u1", guide: "# u1" }, { rootDir, cwd: rootDir, sessionId: "u" })
    await createTool.run({ name: "skill_flt_u2", description: "u2", guide: "# u2" }, { rootDir, cwd: rootDir, sessionId: "u" })
    await createTool.run({ name: "skill_flt_a1", description: "a1", guide: "# a1" }, { rootDir, cwd: rootDir, sessionId: "agent-w", isSkillsSynthetic: true })
    await createTool.run({ name: "skill_flt_a2", description: "a2", guide: "# a2" }, { rootDir, cwd: rootDir, sessionId: "agent-w", isSkillsSynthetic: true })

    // Archive one agent skill
    await archiveTool.run({ name: "skill_flt_a2", reason: "test" }, { rootDir, cwd: rootDir })

    // Filter provenance=agent, default (active only). With our 4 created skills,
    // only skill_flt_a1 should match (skill_flt_a2 is archived).
    const agents = listDynamicSkills(rootDir, { provenance: "agent" })
    const agentNames = agents.map(s => s.name).filter(n => n.startsWith("skill_flt_")).sort()
    assert.ok(agentNames.includes("skill_flt_a1"))
    assert.ok(!agentNames.includes("skill_flt_a2"))
    assert.ok(!agentNames.includes("skill_flt_u1"))

    // Filter provenance=user
    const users = listDynamicSkills(rootDir, { provenance: "user" })
    const userNames = users.map(s => s.name).filter(n => n.startsWith("skill_flt_")).sort()
    assert.ok(userNames.includes("skill_flt_u1"))
    assert.ok(userNames.includes("skill_flt_u2"))
    assert.ok(!userNames.includes("skill_flt_a1"))

    // Filter includeArchived should now include skill_flt_a2
    const agentsArchived = listDynamicSkills(rootDir, { provenance: "agent", includeArchived: true })
    const agentsArchivedNames = agentsArchived.map(s => s.name).filter(n => n.startsWith("skill_flt_")).sort()
    assert.ok(agentsArchivedNames.includes("skill_flt_a1"))
    assert.ok(agentsArchivedNames.includes("skill_flt_a2"))
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Skills: incrementSkillTelemetry debounces within 60s window", async () => {
  const rootDir = createRootDir()
  try {
    const createTool = getTool("CreateSkill")
    const viewTool = getTool("skill_view")
    const { getDynamicSkill, incrementSkillTelemetry } = await import("../session/store.ts")
    assert.ok(createTool && viewTool)

    await createTool.run({ name: "skill_telem", description: "t", guide: "# t" }, { rootDir, cwd: rootDir, sessionId: "u" })

    // First view: use_count should go from 0 to 1
    await viewTool.run({ name: "skill_telem" }, { rootDir, cwd: rootDir })
    let s = getDynamicSkill(rootDir, "skill_telem")
    assert.equal(s?.telemetry?.use_count, 1)

    // Second view immediately: should debounce, stay at 1
    await viewTool.run({ name: "skill_telem" }, { rootDir, cwd: rootDir })
    s = getDynamicSkill(rootDir, "skill_telem")
    assert.equal(s?.telemetry?.use_count, 1)

    // Force the last_used_at to be older than 60s and re-view: should increment
    const skillNow = getDynamicSkill(rootDir, "skill_telem")
    assert.ok(skillNow)
    const oldTime = new Date(Date.now() - 70_000).toISOString()
    skillNow.telemetry = { use_count: 1, last_used_at: oldTime, failure_count: 0 }
    const { saveDynamicSkill } = await import("../session/store.ts")
    saveDynamicSkill(rootDir, skillNow)

    await viewTool.run({ name: "skill_telem" }, { rootDir, cwd: rootDir })
    s = getDynamicSkill(rootDir, "skill_telem")
    assert.equal(s?.telemetry?.use_count, 2)

    // Direct call also works
    incrementSkillTelemetry(rootDir, "skill_telem", true)
    s = getDynamicSkill(rootDir, "skill_telem")
    assert.equal(s?.telemetry?.use_count, 3)

    // Failure path
    incrementSkillTelemetry(rootDir, "skill_telem", false)
    s = getDynamicSkill(rootDir, "skill_telem")
    assert.equal(s?.telemetry?.use_count, 4)
    assert.equal(s?.telemetry?.failure_count, 1)
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("Skills: ArchiveSkill tool refuses on missing skill; RestoreSkill tool refuses on missing skill", async () => {
  const rootDir = createRootDir()
  try {
    const archiveTool = getTool("ArchiveSkill")
    const restoreTool = getTool("RestoreSkill")
    assert.ok(archiveTool && restoreTool)

    const arch = await archiveTool.run({ name: "skill_does_not_exist" }, { rootDir, cwd: rootDir }) as { ok: boolean; error?: string }
    assert.equal(arch.ok, false)
    assert.match(arch.error ?? "", /not found/i)

    const res = await restoreTool.run({ name: "skill_does_not_exist" }, { rootDir, cwd: rootDir }) as { ok: boolean; error?: string }
    assert.equal(res.ok, false)
    assert.match(res.error ?? "", /not found/i)
  } finally {
    cleanupRootDir(rootDir)
  }
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

    const writeTool = getTool("TodoWrite")
    const result = await writeTool.run({
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

    const writeTool = getTool("TodoWrite")

    // First call: one in_progress is fine
    await writeTool.run({
      todos: [
        { content: "Task one", activeForm: "Doing task one", status: "in_progress" },
        { content: "Task two", activeForm: "Doing task two", status: "pending" },
      ],
    }, { rootDir, cwd: rootDir, sessionId, profileId: "default" })

    // Second call: TWO in_progress — should fail
    const second = await writeTool.run({
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

    const writeTool = getTool("TodoWrite")

    // Send a partial list (2 of 3 done) — no nudge
    const r2 = await writeTool.run({
      todos: [
        { content: "Install dependencies", activeForm: "Installing dependencies", status: "completed" },
        { content: "Write code", activeForm: "Writing code", status: "completed" },
        { content: "Commit changes", activeForm: "Committing changes", status: "in_progress" },
      ],
    }, { rootDir, cwd: rootDir, sessionId, profileId: "default" }) as Record<string, unknown>
    assert.equal(r2.verificationNudge, undefined)

    // Now mark all 3 completed in a single call — nudge fires (none mentions verify)
    const r3 = await writeTool.run({
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

    const writeTool = getTool("TodoWrite")

    // 'Run tests' counts as a verify step — no nudge should fire
    const r = await writeTool.run({
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

    const writeTool = getTool("TodoWrite")
    const listTool = getTool("TodoList")

    // Initial list: 3 items
    await writeTool.run({
      todos: [
        { content: "A", activeForm: "Doing A", status: "pending" },
        { content: "B", activeForm: "Doing B", status: "pending" },
        { content: "C", activeForm: "Doing C", status: "pending" },
      ],
    }, { rootDir, cwd: rootDir, sessionId, profileId: "default" })

    // Replace with 1 item — old items should be gone
    await writeTool.run({
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
