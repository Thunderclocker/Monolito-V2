import { test } from "node:test"
import assert from "node:assert/strict"
import { TaskItemTimerController } from "./taskItemTimer.ts"

test("TaskItemTimerController resets item timer when a new task goes in_progress", () => {
  let abortCount = 0
  const timer = new TaskItemTimerController({
    onAbort: () => {
      abortCount++
    },
  })

  timer.beginTurn([], Date.now())
  timer.syncAfterTodoWrite([
    {
      id: "t1",
      content: "First task",
      status: "in_progress",
      createdAt: new Date().toISOString(),
    },
  ])
  timer.syncAfterTodoWrite([
    {
      id: "t1",
      content: "First task",
      status: "completed",
      createdAt: new Date().toISOString(),
    },
    {
      id: "t2",
      content: "Second task",
      status: "in_progress",
      createdAt: new Date().toISOString(),
    },
  ])

  assert.equal(abortCount, 0)
  timer.dispose()
})

test("TaskItemTimerController starts fallback timer when work begins without task list", () => {
  let abortCount = 0
  const timer = new TaskItemTimerController({
    onAbort: () => {
      abortCount++
    },
  })

  timer.beginTurn([], Date.now())
  timer.onWorkActivity()
  assert.equal(abortCount, 0)
  timer.dispose()
})
