import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const daemonPath = fileURLToPath(new URL("./daemon.ts", import.meta.url))

function tryClaimBody() {
  const source = readFileSync(daemonPath, "utf8")
  const match = source.match(/const tryClaim = \(\) => \{([\s\S]*?)\n    \}/)
  assert.ok(match, "daemon.ts must keep a local tryClaim implementation")
  return match[1] ?? ""
}

test("owner claim is written through the exclusively-created file descriptor", () => {
  const body = tryClaimBody()
  assert.match(body, /openSync\(paths\.ownerFile,\s*["']wx["']\)/)
  assert.match(body, /writeFileSync\(this\.ownerFd,/)
  assert.doesNotMatch(body, /writeFileSync\(paths\.ownerFile,/)
})
