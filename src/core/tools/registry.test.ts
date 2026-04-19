import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getTool } from "./registry.ts"
import { appendEvent, appendMessage, appendWorklog, ensureSession, readConfigWing, writeBootWing } from "../session/store.ts"

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

test("tool_manage_config rejects JSON string CONF_CHANNELS values that use bot_token", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    await assert.rejects(
      () => tool.run({
        action: "write",
        wing: "CONF_CHANNELS",
        value: "{\"telegram\":{\"bot_token\":\"abc\",\"enabled\":true,\"allowedChats\":[]}}",
      }, {
        rootDir,
        cwd: rootDir,
      }),
      /must not use 'bot_token'/,
    )
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("tool_manage_config rejects JSON string CONF_CHANNELS values that use root enabled", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    await assert.rejects(
      () => tool.run({
        action: "write",
        wing: "CONF_CHANNELS",
        value: "{\"enabled\":true,\"telegram\":{\"token\":\"abc\",\"enabled\":true,\"allowedChats\":[]}}",
      }, {
        rootDir,
        cwd: rootDir,
      }),
      /unsupported top-level keys: enabled/,
    )
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("tool_manage_config rejects JSON string CONF_CHANNELS values that use session_name", async () => {
  const rootDir = createRootDir()
  try {
    const tool = getTool("tool_manage_config")
    assert.ok(tool)

    await assert.rejects(
      () => tool.run({
        action: "write",
        wing: "CONF_CHANNELS",
        value: "{\"telegram\":{\"token\":\"abc\",\"enabled\":true,\"allowedChats\":[],\"session_name\":\"legacy\"}}",
      }, {
        rootDir,
        cwd: rootDir,
      }),
      /must not use 'session_name'/,
    )
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

test("CanonicalMemoryWrite and CanonicalMemoryRead persist stable profile facts", async () => {
  const rootDir = createRootDir()
  try {
    const writer = getTool("CanonicalMemoryWrite")
    const reader = getTool("CanonicalMemoryRead")
    assert.ok(writer)
    assert.ok(reader)

    await writer.run({
      slot: "assistant_name",
      value: "Amanda",
    }, {
      rootDir,
      cwd: rootDir,
    })

    await writer.run({
      slot: "user_location",
      value: "Santo Tome, Santa Fe, Argentina",
    }, {
      rootDir,
      cwd: rootDir,
    })

    const result = await reader.run({}, {
      rootDir,
      cwd: rootDir,
    })

    assert.equal((result as { state: Record<string, string> }).state.assistant_name, "Amanda")
    assert.equal((result as { state: Record<string, string> }).state.user_location, "Santo Tome, Santa Fe, Argentina")
  } finally {
    cleanupRootDir(rootDir)
  }
})

test("CanonicalMemoryRead falls back to legacy BOOT memory when canonical slots are empty", async () => {
  const rootDir = createRootDir()
  try {
    writeBootWing(rootDir, "BOOT_MEMORY", [
      "# BOOT_MEMORY - Memoria Curada de Largo Plazo",
      "",
      "- Cristian vive en Santo Tome, Santa Fe, Argentina.",
      "- Monolito V2 - identidad del asistente: se llama 'Amanda'.",
    ].join("\n"))

    const reader = getTool("CanonicalMemoryRead")
    assert.ok(reader)

    const result = await reader.run({}, {
      rootDir,
      cwd: rootDir,
    })

    assert.equal((result as { state: Record<string, string> }).state.assistant_name, "Amanda")
    assert.equal((result as { state: Record<string, string> }).state.user_location, "Santo Tome, Santa Fe, Argentina")
  } finally {
    cleanupRootDir(rootDir)
  }
})
