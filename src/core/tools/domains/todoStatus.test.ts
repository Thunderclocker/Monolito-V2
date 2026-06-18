import test from "node:test"
import assert from "node:assert/strict"
import { normalizeTodoStatus } from "./todo.ts"

test("empty / missing status defaults to pending", () => {
  assert.equal(normalizeTodoStatus(""), "pending")
  assert.equal(normalizeTodoStatus("   "), "pending")
  assert.equal(normalizeTodoStatus(undefined), "pending")
  assert.equal(normalizeTodoStatus(null), "pending")
})

test("completed synonyms normalize to completed", () => {
  for (const s of ["completed", "complete", "Done", "FINISHED", "closed", "resolved"]) {
    assert.equal(normalizeTodoStatus(s), "completed", s)
  }
})

test("in_progress synonyms normalize to in_progress", () => {
  for (const s of ["in_progress", "in progress", "in-progress", "doing", "active", "started", "WIP"]) {
    assert.equal(normalizeTodoStatus(s), "in_progress", s)
  }
})

test("unknown status falls back to pending", () => {
  assert.equal(normalizeTodoStatus("blocked"), "pending")
  assert.equal(normalizeTodoStatus("???"), "pending")
})
