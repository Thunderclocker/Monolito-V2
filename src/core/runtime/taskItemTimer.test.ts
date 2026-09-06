import { test } from "node:test"
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import {
  TaskItemTimerController,
  TURN_ABSOLUTE_MAX_MS,
} from "./taskItemTimer.ts"

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

test("TaskItemTimerController counts elapsed time toward the absolute turn limit", async () => {
  let abortCount = 0
  const timer = new TaskItemTimerController({
    onAbort: () => {
      abortCount++
    },
  })

  timer.beginTurn([], Date.now() - (TURN_ABSOLUTE_MAX_MS - 40))
  await delay(100)

  assert.equal(abortCount, 1)
  timer.dispose()
})

test("TaskItemTimerController aborts immediately when the absolute turn limit already expired", () => {
  let abortCount = 0
  const timer = new TaskItemTimerController({
    onAbort: () => {
      abortCount++
    },
  })

  timer.beginTurn([], Date.now() - TURN_ABSOLUTE_MAX_MS - 1)

  assert.equal(abortCount, 1)
  timer.dispose()
})
