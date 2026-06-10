/**
 * Tests for the runtime-DB safety guard in store.ts.
 *
 * Bug (09-jun-2026): a stray test run with MONOLITO_ROOT pointing at the
 * live install (`~/.monolito`) overwrote CONF_CHANNELS.telegram.token with
 * the placeholder "abc", and the bot stopped responding. The root cause
 * was that `getPaths()` resolves via `MONOLITO_ROOT` (the env var) and
 * ignores the `rootDir` argument. A test that forgets to set MONOLITO_ROOT
 * to a tempdir therefore writes to the runtime DB.
 *
 * The fix is a guard at the single DB entry point (`getDb()`) that refuses
 * to open a path ending in `/memory/memory.sqlite` when the process is
 * clearly running tests. The guard is bypassable with MONOLITO_DB_GUARD=0
 * for the rare legitimate "write to live DB from a test" case.
 *
 * The test imports `_runtimeDbGuardForTesting` (a thin export wrapper
 * around the internal `shouldRefuseRuntimeDbAccess`) so we can verify the
 * decision logic without depending on Node's import cache, which would
 * have captured MONOLITO_ROOT at the first import of store.ts.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _runtimeDbGuardForTesting as guard } from "./store.ts"

// Mark this run as a test context so the guard activates. The other env
// vars are reset between scenarios to cover the bypass path.
process.env.NODE_ENV = "test"
process.env.MONOLITO_TEST_GUARD = "1"

test("guard: refuses a canonical runtime path (the exact 09-jun-2026 bug shape)", () => {
  // This is the exact path shape that bit Cristian: the install pin
  // resolves MONOLITO_ROOT to /home/cristian/.monolito, so the live DB
  // sits at /home/cristian/.monolito/memory/memory.sqlite.
  assert.equal(
    guard("/home/cristian/.monolito/memory/memory.sqlite"),
    true,
    "must refuse to open the live runtime DB from a test context",
  )
})

test("guard: refuses ANY path ending in /memory/memory.sqlite outside tmpdir", () => {
  // The guard is path-based, not env-based. It refuses any non-tmpdir
  // memory.sqlite, even if the test process didn't import with the
  // install pin pointing there. This catches e.g. MONOLITO_ROOT=
  // /opt/monolito being set explicitly.
  assert.equal(guard("/opt/monolito/memory/memory.sqlite"), true)
  assert.equal(guard("/var/lib/someapp/memory/memory.sqlite"), true)
  assert.equal(guard("/Users/alice/.monolito/memory/memory.sqlite"), true)
})

test("guard: ALLOWS a path under os.tmpdir() (the happy path for unit tests)", () => {
  // Tests that use mkdtempSync(join(tmpdir(), ...)) and point MONOLITO_ROOT
  // at the tempdir will resolve to a path under os.tmpdir() — those must
  // pass the guard.
  const tempPath = join(tmpdir(), "monolito-test", "memory", "memory.sqlite")
  assert.equal(guard(tempPath), false, "tempdir paths must be allowed")
})

test("guard: ALLOWS a path that does NOT end in /memory/memory.sqlite", () => {
  // The guard is conservative: it only refuses paths that look like the
  // runtime DB. Other paths (a test DB called test.sqlite, etc.) are
  // untouched.
  assert.equal(guard("/home/cristian/.monolito/some-other.db"), false)
  assert.equal(guard("/tmp/test.sqlite"), false)
})

test("guard: bypass via MONOLITO_DB_GUARD=0", () => {
  const previous = process.env.MONOLITO_DB_GUARD
  process.env.MONOLITO_DB_GUARD = "0"
  try {
    // Even the canonical runtime path is allowed with the bypass.
    assert.equal(guard("/home/cristian/.monolito/memory/memory.sqlite"), false)
  } finally {
    if (previous === undefined) {
      delete process.env.MONOLITO_DB_GUARD
    } else {
      process.env.MONOLITO_DB_GUARD = previous
    }
  }
})
