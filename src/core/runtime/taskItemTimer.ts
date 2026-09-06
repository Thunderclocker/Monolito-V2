import { TurnTimeoutError } from "../errors.ts"
import type { SessionTask } from "../session/store.ts"

export const TASK_ITEM_TIMEOUT_MS = 180_000
export const TURN_ABSOLUTE_MAX_MS = 600_000
export const TURN_FALLBACK_TIMEOUT_MS = 180_000

export type TaskItemCompletedArgs = {
  task: SessionTask
  itemStartedAtMs: number
  stepsFromIndex: number
  stepCount: number
}

function clipLabel(value: string, max = 120) {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`
}

export class TaskItemTimerController {
  private absoluteTimer: ReturnType<typeof setTimeout> | null = null
  private activeTimer: ReturnType<typeof setTimeout> | null = null
  private mode: "none" | "item" | "fallback" = "none"
  private taskSnapshot = new Map<string, SessionTask["status"]>()
  private activeItemId: string | null = null
  private activeItemLabel = ""
  private itemStartedAtMs = 0
  private stepsAtItemStart = 0
  private currentStepCount = 0
  private hasTaskList = false
  private callbacks: {
    onAbort: (error: TurnTimeoutError) => void
    onItemCompleted?: (args: TaskItemCompletedArgs) => void
    onLog?: (summary: string) => void
  }

  constructor(callbacks: {
    onAbort: (error: TurnTimeoutError) => void
    onItemCompleted?: (args: TaskItemCompletedArgs) => void
    onLog?: (summary: string) => void
  }) {
    this.callbacks = callbacks
  }

  beginTurn(tasks: SessionTask[], turnStartedAtMs: number) {
    this.hasTaskList = tasks.length > 0
    this.rebuildSnapshot(tasks)

    const abortForAbsoluteLimit = () => {
      this.callbacks.onLog?.(`Turn absolute limit ${TURN_ABSOLUTE_MAX_MS}ms reached`)
      this.callbacks.onAbort(
        new TurnTimeoutError(`Turn exceeded absolute limit of ${TURN_ABSOLUTE_MAX_MS}ms`),
      )
    }
    const elapsedMs = Math.max(0, Date.now() - turnStartedAtMs)
    const remainingMs = TURN_ABSOLUTE_MAX_MS - elapsedMs
    if (remainingMs <= 0) {
      abortForAbsoluteLimit()
      return
    }
    this.absoluteTimer = setTimeout(abortForAbsoluteLimit, remainingMs)

    const inProgress = tasks.find(t => t.status === "in_progress")
    if (inProgress) {
      this.armItemTimer(inProgress)
    }
  }

  updateStepCount(count: number) {
    this.currentStepCount = count
  }

  onWorkActivity() {
    if (this.mode === "none" && !this.hasTaskList) {
      this.armFallbackTimer()
    }
  }

  syncAfterTodoWrite(tasks: SessionTask[]) {
    const prev = new Map(this.taskSnapshot)
    const newlyCompleted: SessionTask[] = []
    let newInProgress: SessionTask | null = null

    for (const task of tasks) {
      const prevStatus = prev.get(task.id)
      if (task.status === "completed" && prevStatus !== "completed") {
        newlyCompleted.push(task)
      }
      if (task.status === "in_progress") {
        newInProgress = task
      }
    }

    for (const task of newlyCompleted) {
      const wasInProgress = prev.get(task.id) === "in_progress"
      if (!wasInProgress) continue
      this.callbacks.onItemCompleted?.({
        task,
        itemStartedAtMs: task.id === this.activeItemId ? this.itemStartedAtMs : Date.now(),
        stepsFromIndex: task.id === this.activeItemId ? this.stepsAtItemStart : 0,
        stepCount: this.currentStepCount,
      })
    }

    this.hasTaskList = tasks.length > 0
    this.rebuildSnapshot(tasks)

    if (newInProgress && newInProgress.id !== this.activeItemId) {
      this.armItemTimer(newInProgress)
      return
    }

    if (!newInProgress && this.mode === "item") {
      this.clearActiveTimer()
      this.mode = "none"
    }
  }

  dispose() {
    this.clearActiveTimer()
    if (this.absoluteTimer) clearTimeout(this.absoluteTimer)
    this.absoluteTimer = null
  }

  private rebuildSnapshot(tasks: SessionTask[]) {
    this.taskSnapshot = new Map(tasks.map(task => [task.id, task.status]))
  }

  private armItemTimer(task: SessionTask) {
    this.clearActiveTimer()
    this.mode = "item"
    this.activeItemId = task.id
    this.activeItemLabel = task.activeForm || task.content
    this.itemStartedAtMs = Date.now()
    this.stepsAtItemStart = this.currentStepCount
    this.callbacks.onLog?.(`Task item timer started (${TASK_ITEM_TIMEOUT_MS}ms): ${this.activeItemLabel}`)
    this.activeTimer = setTimeout(() => {
      this.callbacks.onLog?.(`Task item timeout after ${TASK_ITEM_TIMEOUT_MS}ms: ${this.activeItemLabel}`)
      this.callbacks.onAbort(
        new TurnTimeoutError(
          `Task "${clipLabel(this.activeItemLabel)}" exceeded item limit of ${TASK_ITEM_TIMEOUT_MS}ms`,
        ),
      )
    }, TASK_ITEM_TIMEOUT_MS)
  }

  private armFallbackTimer() {
    this.clearActiveTimer()
    this.mode = "fallback"
    this.callbacks.onLog?.(`Turn fallback timer started (${TURN_FALLBACK_TIMEOUT_MS}ms, no task list)`)
    this.activeTimer = setTimeout(() => {
      this.callbacks.onAbort(
        new TurnTimeoutError(`Turn exceeded working limit of ${TURN_FALLBACK_TIMEOUT_MS}ms`),
      )
    }, TURN_FALLBACK_TIMEOUT_MS)
  }

  private clearActiveTimer() {
    if (this.activeTimer) clearTimeout(this.activeTimer)
    this.activeTimer = null
    this.activeItemId = null
    this.activeItemLabel = ""
    this.itemStartedAtMs = 0
    this.stepsAtItemStart = 0
  }
}
