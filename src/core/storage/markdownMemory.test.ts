import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createMarkdownMemoryStore, memoryMdPath } from "./index.ts"

const root = mkdtempSync(join(tmpdir(), "monolito-md-mem-test-"))
process.env.MONOLITO_ROOT = root
process.env.MONOLITO_MEMORY_BACKEND = "markdown"

test("markdown memory: seed, read boot, write section, cached block", () => {
  const store = createMarkdownMemoryStore(root)
  store.ensureSeeded()
  assert.ok(existsSync(memoryMdPath(root)))
  assert.ok(store.bootWingExists("BOOT_USER"))
  const user = store.readBootWing("BOOT_USER")
  assert.ok(user?.includes("BOOT_USER"))

  store.upsertMemorySection("PC local — seguridad", "- Puerto 22 cerrado", ["pc", "seguridad"])
  const md = store.loadMemoryMd()
  assert.match(md, /PC local — seguridad/)
  assert.match(md, /tags:.*pc/)

  const block = store.buildCachedContextBlock()
  assert.match(block, /<agent_memory_context>/)
  assert.match(block, /BOOT_USER/)
  assert.match(block, /memory\.md/)
})

test.after(() => {
  rmSync(root, { recursive: true, force: true })
})
