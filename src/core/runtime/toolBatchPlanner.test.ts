import test from "node:test"
import assert from "node:assert/strict"
import {
  canRunToolInParallelWave,
  extractToolScopePaths,
  pathsOverlap,
  planToolExecutionWaves,
} from "./toolBatchPlanner.ts"
import type { ToolCall } from "./providers/types.ts"

function call(name: string, input: Record<string, unknown>, index: number) {
  return {
    toolCall: { id: `t${index}`, name, input } satisfies ToolCall,
    index,
  }
}

test("pathsOverlap detects same path and nested directories", () => {
  assert.equal(pathsOverlap("src/a.ts", "src/a.ts"), true)
  assert.equal(pathsOverlap("src", "src/a.ts"), true)
  assert.equal(pathsOverlap("src/a.ts", "lib/b.ts"), false)
})

test("extractToolScopePaths defaults Grep/Glob search root to .", () => {
  assert.deepEqual(extractToolScopePaths("Grep", { pattern: "foo" }), ["."])
  assert.deepEqual(extractToolScopePaths("Read", { path: "README.md" }), ["README.md"])
})

test("planToolExecutionWaves parallelizes disjoint Read calls", () => {
  const waves = planToolExecutionWaves([
    call("Read", { path: "a.ts" }, 0),
    call("Read", { path: "b.ts" }, 1),
  ])
  assert.equal(waves.length, 1)
  assert.equal(waves[0]?.length, 2)
})

test("planToolExecutionWaves splits overlapping Edit calls", () => {
  const waves = planToolExecutionWaves([
    call("Edit", { path: "src/a.ts", old_string: "a", new_string: "b" }, 0),
    call("Edit", { path: "src/a.ts", old_string: "b", new_string: "c" }, 1),
  ])
  assert.equal(waves.length, 2)
})

test("planToolExecutionWaves parallelizes Edit on different files", () => {
  const waves = planToolExecutionWaves([
    call("Edit", { path: "a.ts", old_string: "a", new_string: "b" }, 0),
    call("Edit", { path: "b.ts", old_string: "a", new_string: "b" }, 1),
  ])
  assert.equal(waves.length, 1)
  assert.equal(waves[0]?.length, 2)
})

test("canRunToolInParallelWave rejects Bash in a wave", () => {
  assert.equal(canRunToolInParallelWave("Bash", { command: "ls" }, []), false)
})
