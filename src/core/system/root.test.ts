import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadEnvFile } from "./root.ts"

const TEST_KEY = "MONOLITO_ENV_PRECEDENCE_TEST"

test("loadEnvFile preserves an explicitly provided environment variable", () => {
  const dir = mkdtempSync(join(tmpdir(), "monolito-env-precedence-"))
  const envPath = join(dir, ".env")
  const previous = process.env[TEST_KEY]

  try {
    writeFileSync(envPath, `${TEST_KEY}=from-env-file\n`, "utf8")
    process.env[TEST_KEY] = "from-explicit-env"

    loadEnvFile(envPath)

    assert.equal(process.env[TEST_KEY], "from-explicit-env")
  } finally {
    if (previous === undefined) delete process.env[TEST_KEY]
    else process.env[TEST_KEY] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadEnvFile still fills a missing environment variable from .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "monolito-env-fill-"))
  const envPath = join(dir, ".env")
  const previous = process.env[TEST_KEY]

  try {
    writeFileSync(envPath, `${TEST_KEY}=from-env-file\n`, "utf8")
    delete process.env[TEST_KEY]

    loadEnvFile(envPath)

    assert.equal(process.env[TEST_KEY], "from-env-file")
  } finally {
    if (previous === undefined) delete process.env[TEST_KEY]
    else process.env[TEST_KEY] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})