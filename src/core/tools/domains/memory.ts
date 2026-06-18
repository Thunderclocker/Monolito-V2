// Domain: memory (unified Boot, Memory, Kg tools; legacy names are aliases)

import {
  bootCreateWingInputZod,
  bootWriteInputZod,
  formatToolError,
  optionalString,
  parseZod,
  requireString,
  validateZod,
} from "../internal.ts"

import {
  addGraphTriple,
  bootWingExists,
  createBootWing,
  ensureBootWings,
  fileMemory,
  invalidateGraphTriple,
  listBootWings,
  listMemoryNamespaces,
  listMemorySections,
  queryGraphEntity,
  readBootWing,
  recallMemory,
  getSemanticMessageContext,
  upsertCuratedMemory,
  writeBootWing,
} from "../../session/store.ts"

import {
  BOOT_WING_ORDER,
  isBootWingName,
} from "../../bootstrap/bootWings.ts"

import type { ToolDefinition } from "../registry.ts"

/**
 * Local models frequently invent the argument name (`path`, `file_path`, `key`)
 * and pass a filesystem-ish value (`boot/BOOT_USER.md`, `user.md`) instead of
 * the canonical wing name. Normalize all of that to a valid BOOT_* wing so the
 * write/read does not fail on a cosmetic mismatch.
 */
function normalizeBootWing(raw: string): string {
  let value = raw.trim()
  if (!value) return value
  // Strip any directory prefix and a trailing .md extension.
  value = value.split(/[\\/]/).pop() ?? value
  value = value.replace(/\.md$/i, "").trim()
  const upper = value.toUpperCase()
  if (isBootWingName(upper)) return upper
  const prefixed = `BOOT_${upper}`
  if (isBootWingName(prefixed)) return prefixed
  return value
}

function resolveBootFileKey(input: Record<string, unknown>) {
  const raw =
    optionalString(input, "file") ??
    optionalString(input, "wing") ??
    optionalString(input, "key") ??
    optionalString(input, "path") ??
    optionalString(input, "file_path")
  return raw ? normalizeBootWing(raw) : undefined
}

type BootAction = "read" | "write" | "list" | "create"

function resolveBootAction(invoked: string, input: Record<string, unknown>): BootAction {
  const explicit = optionalString(input, "action")
  if (explicit === "read" || explicit === "write" || explicit === "list" || explicit === "create") return explicit
  if (invoked === "BootRead") return "read"
  if (invoked === "BootWrite") return "write"
  if (invoked === "BootListFiles" || invoked === "BootListWings") return "list"
  if (invoked === "BootCreateFile" || invoked === "BootCreateWing") return "create"
  if (typeof input.content === "string") return "write"
  if (resolveBootFileKey(input)) return "read"
  return "list"
}

type MemoryAction = "file" | "recall"

function resolveMemoryAction(invoked: string, input: Record<string, unknown>): MemoryAction {
  const explicit = optionalString(input, "action")
  if (explicit === "file" || explicit === "recall") return explicit
  if (invoked === "WorkspaceMemoryFiling") return "file"
  if (invoked === "WorkspaceMemoryRecall") return "recall"
  if (typeof input.content === "string" && input.content.trim().length > 0) return "file"
  return "recall"
}

type KgAction = "add" | "query" | "invalidate"

function resolveKgAction(invoked: string, input: Record<string, unknown>): KgAction {
  const explicit = optionalString(input, "action")
  if (explicit === "add" || explicit === "query" || explicit === "invalidate") return explicit
  if (invoked === "KgAdd") return "add"
  if (invoked === "KgQuery") return "query"
  if (invoked === "KgInvalidate") return "invalidate"
  if (optionalString(input, "entity")) return "query"
  if (optionalString(input, "valid_to")) return "invalidate"
  return "add"
}

export const memoryTools: ToolDefinition[] = [
{
  name: "Boot",
  aliases: ["BootRead", "BootWrite", "BootListFiles", "BootListWings", "BootCreateFile", "BootCreateWing"],
  permissionTier: "edit",
  description:
    "Manage boot context files. action=read|write|list|create. To save the user's profile use action=write with file=BOOT_USER; for agent identity use file=BOOT_IDENTITY. Pass the boot wing name in `file` (e.g. BOOT_USER), not a filesystem path.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "write", "list", "create"] },
      file: {
        type: "string",
        enum: [...BOOT_WING_ORDER],
        description:
          "Boot wing to read/write. BOOT_USER=user profile, BOOT_IDENTITY=agent name/identity, BOOT_SOUL=behavioral preferences, BOOT_AGENTS=workspace rules, BOOT_TOOLS=tool conventions, BOOT_MEMORY=long-term memory, BOOT_BOOTSTRAP=onboarding state.",
      },
      wing: { type: "string", description: "Alias for `file`." },
      content: { type: "string", description: "For write: the full new markdown content of the wing (overwrites by default)." },
      mode: { type: "string", enum: ["overwrite", "append"], description: "For write. Default overwrite." },
    },
    additionalProperties: false,
  },
  concurrencySafe: false,
  async run(input, context) {
    const invoked = context.invokedAs ?? "Boot"
    const action = resolveBootAction(invoked, input as Record<string, unknown>)
    const profile = context.profileId ?? "default"
    try {
      if (action === "list") {
        return JSON.stringify({ profile, files: listBootWings(context.rootDir, profile) })
      }
      const file = resolveBootFileKey(input as Record<string, unknown>)
      if (action === "read") {
        if (!file) return formatToolError("file is required")
        ensureBootWings(context.rootDir, profile)
        if (!bootWingExists(context.rootDir, file, profile)) {
          return formatToolError(`Boot file ${file} not found. Use action=list.`)
        }
        const content = readBootWing(context.rootDir, file, profile)
        if (content == null) return formatToolError(`Boot file ${file} not found`)
        return { file, content, profile }
      }
      if (action === "create") {
        if (!file) return formatToolError("file is required")
        const wing = file.trim()
        const wingErr = validateZod(bootCreateWingInputZod, { wing })
        if (wingErr) return wingErr
        if (!isBootWingName(wing)) {
          return formatToolError(`Cannot create "${wing}". Allowed: ${BOOT_WING_ORDER.join(", ")}.`)
        }
        if (bootWingExists(context.rootDir, wing, profile)) {
          return formatToolError(`Boot file ${wing} already exists. Use write.`)
        }
        const result = createBootWing(context.rootDir, wing, profile, "")
        return { ok: true, file: wing, created: result.created, profile }
      }
      if (!file) return formatToolError("file is required")
      const legacyMode = optionalString(input, "action")
      const writeMode = optionalString(input, "mode")
        ?? (legacyMode === "append" || legacyMode === "overwrite" ? legacyMode : "overwrite")
      const parsed = parseZod(bootWriteInputZod, { ...input, wing: file, action: writeMode }, "Boot write")
      if (!bootWingExists(context.rootDir, parsed.wing, profile)) {
        return formatToolError(`Boot file ${parsed.wing} does not exist. Use create first.`)
      }
      const result = writeBootWing(context.rootDir, parsed.wing, parsed.content, profile, parsed.action === "append")
      return { file: parsed.wing, ok: true, changed: result.changed, bytes: result.bytes, profile }
    } catch (error) {
      return formatToolError(error)
    }
  },
},

{
  name: "Memory",
  aliases: ["WorkspaceMemoryFiling", "WorkspaceMemoryRecall"],
  permissionTier: "edit",
  description: "Curated memory.md sections. action=file stores facts; action=recall keyword-searches.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["file", "recall"] },
      namespace: { type: "string" },
      section: { type: "string" },
      key: { type: "string" },
      content: { type: "string" },
      query: { type: "string" },
    },
    additionalProperties: false,
  },
  concurrencySafe: false,
  async run(input, context) {
    const invoked = context.invokedAs ?? "Memory"
    const action = resolveMemoryAction(invoked, input as Record<string, unknown>)
    const namespace = optionalString(input, "namespace") ?? optionalString(input, "wing")
    const section = optionalString(input, "section") ?? optionalString(input, "room")
    const key = optionalString(input, "key")
    const query = optionalString(input, "query")

    if (action === "file") {
      if (!namespace || !section) return formatToolError("namespace and section are required")
      const content = requireString(input, "content")
      const result = key
        ? await upsertCuratedMemory(context.rootDir, namespace, section, content, context.profileId, key)
        : { id: await fileMemory(context.rootDir, namespace, section, content, context.profileId), action: "inserted" as const }
      return { ok: true, id: result.id, action: result.action, namespace, section, key: key ?? null, shared: namespace.trim().toUpperCase() === "SHARED" }
    }

    let results: unknown[] = []
    try {
      results = await recallMemory(context.rootDir, namespace, section, query, context.profileId, key)
    } catch (error) {
      return formatToolError(error)
    }
    if (!namespace && !section && !key && !query) {
      return { namespaces: listMemoryNamespaces(context.rootDir, context.profileId), recentMemories: results }
    }
    if (namespace && !section && !key && !query) {
      return { namespace, sections: listMemorySections(context.rootDir, namespace, context.profileId), memories: results }
    }
    return { namespace, section, key, query, keywordSearchActive: !!query, memories: results }
  },
},

{
  name: "Kg",
  aliases: ["KgAdd", "KgQuery", "KgInvalidate"],
  permissionTier: "edit",
  description: "Temporal knowledge graph. action=add|query|invalidate.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "query", "invalidate"] },
      entity: { type: "string" },
      subject: { type: "string" },
      predicate: { type: "string" },
      object: { type: "string" },
      valid_from: { type: "string" },
      valid_to: { type: "string" },
    },
    additionalProperties: false,
  },
  concurrencySafe: false,
  async run(input, context) {
    const invoked = context.invokedAs ?? "Kg"
    const action = resolveKgAction(invoked, input as Record<string, unknown>)
    const profileId = context.profileId ?? "default"
    if (action === "query") {
      const entity = requireString(input, "entity")
      return { ok: true, profileId, entity, facts: queryGraphEntity(context.rootDir, profileId, entity) }
    }
    const subject = requireString(input, "subject")
    const predicate = requireString(input, "predicate")
    const object = requireString(input, "object")
    if (action === "invalidate") {
      const validTo = optionalString(input, "valid_to") ?? new Date().toISOString()
      const result = invalidateGraphTriple(context.rootDir, profileId, subject, predicate, object, validTo)
      return { ok: result.changes > 0, profileId, subject, predicate, object, valid_to: validTo, invalidated: result.changes }
    }
    const validFrom = optionalString(input, "valid_from") ?? new Date().toISOString()
    const id = addGraphTriple(context.rootDir, profileId, subject, predicate, object, validFrom)
    return { ok: true, id, profileId, subject, predicate, object, valid_from: validFrom, active: true }
  },
},

{
  name: "SearchHistory",
  aliases: ["search_history"],
  permissionTier: "read",
  description: "Search prior chat messages by keyword over session history JSONL.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  concurrencySafe: true,
  async run(input, context) {
    const query = requireString(input, "query")
    const limit = typeof input.limit === "number" ? Math.min(20, Math.max(1, input.limit)) : 8
    try {
      const rows = getSemanticMessageContext(context.rootDir, query, limit)
      return {
        query,
        count: rows.length,
        matches: rows.map(r => ({
          session_id: r.session_id,
          role: r.role,
          at: r.at,
          text: r.text.length > 1200 ? `${r.text.slice(0, 1200)}...` : r.text,
        })),
      }
    } catch (error) {
      return formatToolError(error)
    }
  },
},
]
