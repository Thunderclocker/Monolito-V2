// Domain: todo (unified Todo tool; legacy names are aliases)

import { randomUUID } from "node:crypto"
import { formatToolError, optionalString } from "../internal.ts"
import {
  supersedeAllSessionTasks,
  listSessionTasks,
  writeSessionTask,
} from "../../session/store.ts"
import type { SessionTask } from "../../session/store.ts"
import type { ToolDefinition } from "../registry.ts"

type TodoAction = "write" | "list"

function inferTodoAction(input: Record<string, unknown>): TodoAction {
  const action = optionalString(input, "action")
  if (action === "write" || action === "list") return action
  if ("todos" in input) return "write"
  return "list"
}

export function normalizeTodoStatus(raw: unknown): "pending" | "in_progress" | "completed" {
  if (typeof raw !== "string") return "pending"
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (["completed", "complete", "done", "finished", "closed", "resolved", "ready"].includes(k)) return "completed"
  if (["in_progress", "inprogress", "doing", "active", "started", "working", "wip", "ongoing", "running"].includes(k)) return "in_progress"
  return "pending"
}

function normalizeTodosInput(rawTodos: unknown): unknown[] {
  if (Array.isArray(rawTodos)) return rawTodos
  if (rawTodos && typeof rawTodos === "object" && Array.isArray((rawTodos as { item?: unknown }).item)) {
    return (rawTodos as { item: unknown[] }).item
  }
  if (rawTodos && typeof rawTodos === "object" && Array.isArray((rawTodos as { todos?: unknown }).todos)) {
    return (rawTodos as { todos: unknown[] }).todos
  }
  return []
}

async function runTodoWrite(input: Record<string, unknown>, context: { rootDir: string; sessionId?: string; profileId?: string }) {
  const profileId = context.profileId || "default"
  const sessionId = context.sessionId
  if (!sessionId) return formatToolError("No active session ID found in context.")
  if (!("todos" in input)) {
    const gotKeys = Object.keys(input).join(", ")
    return formatToolError(
      `Todo write: input must include 'todos' array. Got keys: [${gotKeys}]. Expected: {todos: [{content, activeForm, status: 'pending'|'in_progress'|'completed'}]}.`,
    )
  }
  const todos = normalizeTodosInput((input as { todos: unknown }).todos)
  if (todos.length === 0) {
    return formatToolError("Todo write: todos array is empty. To mark all done, send [{content: 'All previous tasks completed', activeForm: 'Wrapping up', status: 'completed'}] explicitly.")
  }

  // Local models (gpt-oss et al.) frequently emit partially-formed todo items
  // (missing/empty activeForm, empty or synonym status). Repair instead of
  // hard-failing, mirroring the tolerant Boot tool: derive the missing field
  // from its sibling, normalize status synonyms (default 'pending'), and drop
  // items that are entirely empty. Hard-failing here loses the model's intent
  // and surfaces noisy "TodoWrite failed" lines to the user.
  type RepairedTodo = { content: string; activeForm: string; status: "pending" | "in_progress" | "completed"; category?: "cognitive" | "life" }
  const repaired: RepairedTodo[] = []
  for (let i = 0; i < todos.length; i++) {
    const t = (todos[i] ?? {}) as Record<string, unknown>
    let content = typeof t.content === "string" ? t.content.trim() : ""
    let activeForm = typeof t.activeForm === "string" ? t.activeForm.trim() : ""
    if (!content) content = activeForm
    if (!activeForm) activeForm = content
    if (!content) continue
    const status = normalizeTodoStatus(t.status)
    const rawCategory = typeof t.category === "string" ? t.category.trim().toLowerCase() : ""
    const category = rawCategory === "cognitive" || rawCategory === "life" ? rawCategory : undefined
    repaired.push({ content, activeForm, status, category })
  }
  if (repaired.length === 0) {
    return formatToolError("Todo write: no usable todos after normalization (every item lacked content/activeForm).")
  }

  // Enforce the single-in_progress invariant by demotion rather than error:
  // keep the first in_progress item, demote the rest to pending.
  let seenInProgress = false
  for (const t of repaired) {
    if (t.status !== "in_progress") continue
    if (seenInProgress) t.status = "pending"
    else seenInProgress = true
  }

  const now = new Date().toISOString()
  supersedeAllSessionTasks(context.rootDir, sessionId, profileId)

  const persisted: SessionTask[] = []
  for (const tt of repaired) {
    const taskId = `task-${randomUUID().slice(0, 8)}`
    const task: SessionTask = {
      id: taskId,
      sessionId,
      content: tt.content,
      activeForm: tt.activeForm,
      status: tt.status,
      createdAt: now,
      updatedAt: now,
      category: tt.category || "cognitive",
    }
    writeSessionTask(context.rootDir, sessionId, taskId, task, profileId)
    persisted.push(task)
  }

  let verificationNudge: string | undefined
  const allDone = persisted.length > 0 && persisted.every(t => t.status === "completed")
  const hasVerificationStep = persisted.some(t =>
    /\b(verif|test|check|validate|assert|confirm|audit|review|inspect|examine|run\s+tests?|build\s+and|smoke)\b/i.test(t.content),
  )
  if (allDone && persisted.length >= 3 && !hasVerificationStep) {
    verificationNudge =
      "You just closed out 3+ tasks and none of them was a verification step. " +
      "Before writing your final summary, add and execute at least one verification step " +
      "(e.g. 'Run tests', 'Validate output', 'Confirm with tool evidence') and mark it completed."
  }

  const result: Record<string, unknown> = { todos: persisted, totalInSession: persisted.length, profile: profileId }
  if (verificationNudge) result.verificationNudge = verificationNudge
  return result
}

async function runTodoList(input: Record<string, unknown>, context: { rootDir: string; sessionId?: string; profileId?: string }) {
  const filter = optionalString(input, "filter") ?? "all"
  const profileId = context.profileId || "default"
  const sessionId = context.sessionId
  if (!sessionId) return formatToolError("No active session ID found in context.")
  const tasks = listSessionTasks(context.rootDir, sessionId, profileId)
  const filtered = filter === "all" ? tasks : tasks.filter(t => t.status === filter)
  return { tasks: filtered, totalInSession: tasks.length, filter, profile: profileId }
}

export const todoTools: ToolDefinition[] = [
{
  name: "Todo",
  aliases: ["TodoWrite", "TodoList"],
  permissionTier: "edit",
  description: "Manage the session cognitive task list. action='write': replace the full todo list atomically with {todos:[{content, activeForm, status}]}. action='list': list tasks (optional filter: all|pending|in_progress|completed). Legacy alias TodoWrite maps to write; TodoList maps to list. Exactly ONE todo may be in_progress.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["write", "list"], description: "write = replace task list; list = read tasks." },
      todos: {
        type: "array",
        description: "Required for action=write. Full updated todo list.",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            activeForm: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            category: { type: "string", enum: ["cognitive", "life"] },
          },
          required: ["content", "activeForm", "status"],
          additionalProperties: false,
        },
      },
      filter: { type: "string", enum: ["all", "pending", "in_progress", "completed"], description: "For action=list." },
    },
    additionalProperties: false,
  },
  concurrencySafe: true,
  async run(input, context) {
    const invoked = context.invokedAs ?? "Todo"
    const record = input as Record<string, unknown>
    const actionParam = optionalString(record, "action")
    if (actionParam === "search" || actionParam === "fetch" || actionParam === "image_search" || "query" in record) {
      return formatToolError("Todo does not search the web — use Web (action=search|fetch|image_search) with {query} or {url,prompt}.")
    }
    const action = invoked === "TodoWrite" ? "write" : invoked === "TodoList" ? "list" : inferTodoAction(record)
    return action === "write"
      ? runTodoWrite(input as Record<string, unknown>, context)
      : runTodoList(input as Record<string, unknown>, context)
  },
},
]
