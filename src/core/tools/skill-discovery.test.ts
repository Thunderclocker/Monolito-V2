// Tests para skill-discovery.ts

import test from "node:test"
import assert from "node:assert/strict"
import {
  discoverSkillsForPath,
  uniqueSkillIds,
} from "./skill-discovery.ts"

test("discoverSkillsForPath: TypeScript file → typescript-style", async () => {
  const skills = await discoverSkillsForPath("/tmp", "src/foo.ts")
  assert.ok(skills.some(s => s.id === "typescript-style"))
})

test("discoverSkillsForPath: Python file → python-style", async () => {
  const skills = await discoverSkillsForPath("/tmp", "src/main.py")
  assert.ok(skills.some(s => s.id === "python-style"))
})

test("discoverSkillsForPath: Dockerfile → docker", async () => {
  const skills = await discoverSkillsForPath("/tmp", "/repo/Dockerfile")
  assert.ok(skills.some(s => s.id === "docker"))
  assert.ok(skills.some(s => s.source === "name"))
})

test("discoverSkillsForPath: test directory → test-runner", async () => {
  const skills = await discoverSkillsForPath("/tmp", "/repo/tests/foo.test.ts")
  assert.ok(skills.some(s => s.id === "test-runner"))
})

test("discoverSkillsForPath: docs directory → docs", async () => {
  const skills = await discoverSkillsForPath("/tmp", "/repo/docs/intro.md")
  assert.ok(skills.some(s => s.id === "docs"))
})

test("discoverSkillsForPath: SQL → sql-style", async () => {
  const skills = await discoverSkillsForPath("/tmp", "/db/schema.sql")
  assert.ok(skills.some(s => s.id === "sql-style"))
})

test("discoverSkillsForPath: random file → no skills", async () => {
  const skills = await discoverSkillsForPath("/tmp", "/tmp/abc.xyz")
  // No matches expected
  assert.equal(skills.length, 0)
})

test("uniqueSkillIds: dedupes", () => {
  const ids = uniqueSkillIds([
    { id: "x", source: "path", reason: "" },
    { id: "x", source: "name", reason: "" },
    { id: "y", source: "path", reason: "" },
  ])
  assert.deepEqual(ids.sort(), ["x", "y"])
})
