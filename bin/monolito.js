#!/usr/bin/env node
// Monolito CLI entrypoint — installed via npm link or npm install -g
// Resolves the project root from this file's location (bin/ → root).
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"

const __filename = fileURLToPath(import.meta.url)
const projectRoot = dirname(dirname(__filename))
const cliPath = join(projectRoot, "src", "apps", "cli.ts")

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", cliPath, ...process.argv.slice(2)],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  }
)

process.exit(result.status ?? 1)
