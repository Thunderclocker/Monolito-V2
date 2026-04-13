import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getTool } from "./registry.ts"
import { readConfigWing } from "../session/store.ts"

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
