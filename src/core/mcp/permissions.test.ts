import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname } from "node:path"
import { configWingPath } from "../storage/filePaths.ts"
import type { ToolContext } from "../tools/internal.ts"
import { clearMcpPermissionCache, isMcpPermissionEnabled } from "./permissions.ts"

function makeContext(rootDir: string): ToolContext {
  return { rootDir } as ToolContext
}

function withRoot(run: (rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = mkdtempSync(`${tmpdir()}/monolito-mcp-policy-`)
  return run(rootDir).finally(() => {
    clearMcpPermissionCache(rootDir)
    rmSync(rootDir, { recursive: true, force: true })
  })
}

test("MCP permissions default allow only when CONF_POLICY is absent", async () => {
  await withRoot(async rootDir => {
    assert.equal(await isMcpPermissionEnabled(makeContext(rootDir), "demo", "read"), true)
  })
})

test("MCP permissions fail closed when CONF_POLICY contains malformed JSON", async () => {
  await withRoot(async rootDir => {
    const path = configWingPath(rootDir, "CONF_POLICY")
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "{not-json", "utf8")

    assert.equal(await isMcpPermissionEnabled(makeContext(rootDir), "demo", "read"), false)
  })
})

test("MCP permissions fail closed when CONF_POLICY has an invalid shape", async () => {
  await withRoot(async rootDir => {
    const path = configWingPath(rootDir, "CONF_POLICY")
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ permissions: { mode: "default", rules: "not-an-array" } }), "utf8")

    assert.equal(await isMcpPermissionEnabled(makeContext(rootDir), "demo", "read"), false)
  })
})

test("MCP permissions preserve valid explicit allow and deny rules", async () => {
  await withRoot(async rootDir => {
    const path = configWingPath(rootDir, "CONF_POLICY")
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      permissions: {
        mode: "default",
        rules: [
          { tool: "Mcp:demo:read", action: "allow" },
          { tool: "Mcp:demo:write", action: "deny" },
        ],
      },
    }), "utf8")

    const context = makeContext(rootDir)
    assert.equal(await isMcpPermissionEnabled(context, "demo", "read"), true)
    assert.equal(await isMcpPermissionEnabled(context, "demo", "write"), false)
  })
})
