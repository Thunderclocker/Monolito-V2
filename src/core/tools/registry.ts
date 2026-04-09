import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { ensureDirs, getPaths } from "../ipc/protocol.ts"
import { type StdioMcpClient, getDefaultMcpServers } from "../mcp/client.ts"
import { readChannelsConfig } from "../channels/config.ts"
import { fileMemory, recallMemory, listWings, listRooms, listProfiles, createProfile } from "../session/store.ts"
import { type AgentOrchestrator } from "../runtime/orchestrator.ts"

const execFileAsync = promisify(execFile)
const DEFAULT_GREP_LIMIT = 250
const DEFAULT_BASH_TIMEOUT_MS = 120_000
const MAX_EXEC_BUFFER = 4 * 1024 * 1024

export type ToolContext = {
  rootDir: string
  cwd: string
  profileId?: string
  getMcpClient?: (serverName: string) => Promise<StdioMcpClient>
  orchestrator?: AgentOrchestrator
}

export type ToolInputSchema = {
  type: "object"
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export type ToolDefinition = {
  name: string
  aliases?: string[]
  description: string
  inputSchema: ToolInputSchema
  concurrencySafe?: boolean | ((input: Record<string, unknown>) => boolean)
  validate?: (input: Record<string, unknown>) => string | null
  run: (input: Record<string, unknown>, context: ToolContext) => Promise<unknown>
}

const emptyInputSchema: ToolInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
}

const optionalPathInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
  },
  additionalProperties: false,
}

function resolveWorkspacePath(rootDir: string, cwd: string, target = ".") {
  const resolvedRoot = resolve(rootDir)
  const absolute = resolve(cwd, target)
  if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}/`)) {
    throw new Error(`Path escapes workspace: ${target}`)
  }
  return absolute
}

function toWorkspaceRelative(rootDir: string, absolute: string) {
  const relativePath = relative(rootDir, absolute)
  return relativePath.length === 0 ? "." : relativePath
}

function normalizePathInput(input: Record<string, unknown>, key = "path") {
  const value = input[key]
  return typeof value === "string" && value.length > 0 ? value : "."
}

function requireString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`)
  }
  return value
}

function optionalString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function optionalNumber(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function optionalBoolean(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "boolean" ? value : undefined
}

async function telegramApiCall(token: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  })
  return await response.json() as { ok: boolean; result?: unknown; description?: string }
}

function isLocalPath(value: string) {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/")
}

async function telegramApiCallWithFile(
  token: string,
  method: string,
  fileField: string,
  filePath: string,
  params: Record<string, unknown>,
) {
  const resolvedPath = filePath.startsWith("~/")
    ? filePath.replace("~/", `${process.env.HOME ?? ""}/`)
    : filePath

  if (!existsSync(resolvedPath)) {
    return { ok: false, description: `File not found: ${resolvedPath}` }
  }

  const fileData = readFileSync(resolvedPath)
  const fileName = resolvedPath.split("/").at(-1) ?? "upload.bin"
  const formData = new FormData()
  formData.append(fileField, new Blob([fileData]), fileName)

  for (const [key, value] of Object.entries(params)) {
    if (key === fileField) continue
    if (value !== undefined && value !== null) {
      formData.append(key, typeof value === "object" ? JSON.stringify(value) : String(value))
    }
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(30_000),
  })
  return await response.json() as { ok: boolean; result?: unknown; description?: string }
}

async function resolveTelegramDownload(
  token: string,
  fileId: string,
  rootDir: string,
  filename?: string,
) {
  const fileInfo = await telegramApiCall(token, "getFile", { file_id: fileId })
  if (!fileInfo.ok || !fileInfo.result || typeof fileInfo.result !== "object") {
    throw new Error(`Failed to get Telegram file info: ${fileInfo.description ?? "unknown error"}`)
  }

  const result = fileInfo.result as { file_path?: string }
  if (!result.file_path) {
    throw new Error("Telegram did not return file_path for this file_id.")
  }

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${result.file_path}`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: HTTP ${response.status}`)
  }

  const paths = ensureDirs(rootDir)
  const downloadsDir = join(paths.scratchpadDir, "telegram-downloads")
  mkdirSync(downloadsDir, { recursive: true })
  const originalName = result.file_path.split("/").at(-1) ?? fileId
  const extension = originalName.includes(".") ? `.${originalName.split(".").at(-1)}` : ""
  const saveName = filename
    ? (filename.includes(".") ? filename : `${filename}${extension}`)
    : originalName
  const localPath = join(downloadsDir, saveName)
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(localPath, buffer)

  return {
    ok: true,
    file_id: fileId,
    file_path: result.file_path,
    local_path: localPath,
    bytes: buffer.length,
  }
}

async function runRg(args: string[], cwd: string) {
  try {
    return await execFileAsync("rg", args, {
      cwd,
      maxBuffer: MAX_EXEC_BUFFER,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    })
  } catch (error) {
    const typed = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }
    if (typed.code === 1) {
      return { stdout: typed.stdout ?? "", stderr: typed.stderr ?? "" }
    }
    if (typed.code === "ENOENT") {
      throw new Error("rg is required but not installed")
    }
    throw error
  }
}

async function getMcpClient(context: ToolContext, serverName: string) {
  if (context.getMcpClient) return context.getMcpClient(serverName)
  const server = getDefaultMcpServers(context.rootDir)[serverName as keyof ReturnType<typeof getDefaultMcpServers>]
  if (!server) throw new Error(`Unknown MCP server: ${serverName}`)
  const { StdioMcpClient } = await import("../mcp/client.ts")
  const client = new StdioMcpClient(server.command, server.cwd)
  await client.initialize()
  return client
}

async function fetchWithCurl(url: string) {
  const result = await execFileAsync("curl", ["-fsSL", "--max-time", "15", url], {
    maxBuffer: MAX_EXEC_BUFFER,
    env: process.env,
  })
  return {
    code: 200,
    codeText: "OK",
    bytes: Buffer.byteLength(result.stdout),
    content: result.stdout,
  }
}

const tools: ToolDefinition[] = [
  {
    name: "pwd",
    description: "Return the current workspace directory.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run(_input, context) {
      return { cwd: context.cwd }
    },
  },
  {
    name: "list_files",
    description: "List files in a workspace-relative directory.",
    inputSchema: optionalPathInputSchema,
    concurrencySafe: true,
    async run(input, context) {
      const target = normalizePathInput(input)
      const directory = resolveWorkspacePath(context.rootDir, context.cwd, target)
      return readdirSync(directory).map(name => {
        const absolute = join(directory, name)
        const stats = statSync(absolute)
        return {
          name,
          path: toWorkspaceRelative(context.rootDir, absolute),
          type: stats.isDirectory() ? "dir" : "file",
        }
      })
    },
  },
  {
    name: "Read",
    aliases: ["read_file"],
    description: "Read a UTF-8 file from the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => typeof input.path === "string" && input.path.length > 0 ? null : "path must be a non-empty string",
    async run(input, context) {
      const path = requireString(input, "path")
      const file = resolveWorkspacePath(context.rootDir, context.cwd, path)
      const content = readFileSync(file, "utf8")
      return { path, content }
    },
  },
  {
    name: "Write",
    aliases: ["write_file"],
    description: "Create or overwrite a file in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => {
      if (typeof input.path !== "string" || input.path.length === 0) return "path must be a non-empty string"
      if (typeof input.content !== "string" || input.content.length === 0) return "content must be a non-empty string"
      return null
    },
    async run(input, context) {
      const path = requireString(input, "path")
      const content = requireString(input, "content")
      const file = resolveWorkspacePath(context.rootDir, context.cwd, path)
      mkdirSync(dirname(file), { recursive: true })
      const existed = existsSync(file)
      writeFileSync(file, content, "utf8")
      return { path, type: existed ? "update" : "create", bytes: Buffer.byteLength(content) }
    },
  },
  {
    name: "Edit",
    aliases: ["edit_file"],
    description: "Edit a file in place by replacing an existing string.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => {
      if (typeof input.path !== "string" || input.path.length === 0) return "path must be a non-empty string"
      if (typeof input.old_string !== "string" || input.old_string.length === 0) return "old_string must be a non-empty string"
      if (typeof input.new_string !== "string") return "new_string must be a string"
      return null
    },
    async run(input, context) {
      const path = requireString(input, "path")
      const oldString = requireString(input, "old_string")
      const newString = requireString(input, "new_string")
      const replaceAll = optionalBoolean(input, "replace_all") ?? false
      const file = resolveWorkspacePath(context.rootDir, context.cwd, path)
      const original = readFileSync(file, "utf8")
      const occurrences = original.split(oldString).length - 1
      if (occurrences === 0) throw new Error(`old_string not found in ${path}`)
      if (!replaceAll && occurrences > 1) {
        throw new Error(`old_string matched ${occurrences} times in ${path}; set replace_all=true`)
      }
      const updated = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString)
      writeFileSync(file, updated, "utf8")
      return { path, replaced: replaceAll ? occurrences : 1, bytes: Buffer.byteLength(updated) }
    },
  },
  {
    name: "Glob",
    aliases: ["glob"],
    description: "Find files by glob pattern inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        head_limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => typeof input.pattern === "string" && input.pattern.length > 0 ? null : "pattern must be a non-empty string",
    async run(input, context) {
      const pattern = requireString(input, "pattern")
      const target = normalizePathInput(input)
      const headLimit = optionalNumber(input, "head_limit") ?? 100
      const offset = optionalNumber(input, "offset") ?? 0
      const absoluteTarget = resolveWorkspacePath(context.rootDir, context.cwd, target)
      const relativeTarget = toWorkspaceRelative(context.rootDir, absoluteTarget)
      const result = await runRg(["--files", relativeTarget === "." ? "." : relativeTarget, "-g", pattern], context.rootDir)
      const matches = result.stdout.split("\n").map(line => line.trim()).filter(Boolean)
      const filenames = headLimit === 0 ? matches.slice(offset) : matches.slice(offset, offset + headLimit)
      return {
        pattern,
        path: target,
        numFiles: filenames.length,
        filenames,
        truncated: headLimit === 0 ? false : matches.length - offset > headLimit,
        appliedOffset: offset,
        appliedLimit: headLimit === 0 ? undefined : headLimit,
      }
    },
  },
  {
    name: "Grep",
    aliases: ["grep"],
    description: "Search file contents with ripgrep.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
        glob: { type: "string" },
        ignore_case: { type: "boolean" },
        multiline: { type: "boolean" },
        head_limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => typeof input.pattern === "string" && input.pattern.length > 0 ? null : "pattern must be a non-empty string",
    async run(input, context) {
      const pattern = requireString(input, "pattern")
      const target = normalizePathInput(input)
      const absoluteTarget = resolveWorkspacePath(context.rootDir, context.cwd, target)
      const relativeTarget = toWorkspaceRelative(context.rootDir, absoluteTarget)
      const outputMode = optionalString(input, "output_mode") ?? "files_with_matches"
      const glob = optionalString(input, "glob")
      const ignoreCase = optionalBoolean(input, "ignore_case") ?? false
      const multiline = optionalBoolean(input, "multiline") ?? false
      const headLimit = optionalNumber(input, "head_limit") ?? DEFAULT_GREP_LIMIT
      const offset = optionalNumber(input, "offset") ?? 0
      const args: string[] = []
      if (ignoreCase) args.push("-i")
      if (multiline) args.push("-U", "--multiline-dotall")
      if (glob) args.push("--glob", glob)
      if (outputMode === "content") {
        const result = await runRg([...args, "-n", pattern, relativeTarget], context.rootDir)
        const lines = result.stdout.split("\n").filter(Boolean)
        const page = headLimit === 0 ? lines.slice(offset) : lines.slice(offset, offset + headLimit)
        return {
          mode: "content",
          content: page.join("\n"),
          numLines: page.length,
          appliedOffset: offset,
          appliedLimit: headLimit === 0 ? undefined : headLimit,
        }
      }
      if (outputMode === "count") {
        const result = await runRg([...args, "-c", pattern, relativeTarget], context.rootDir)
        const lines = result.stdout.split("\n").filter(Boolean)
        const page = headLimit === 0 ? lines.slice(offset) : lines.slice(offset, offset + headLimit)
        return {
          mode: "count",
          numMatches: page.reduce((total, line) => {
            const count = Number(line.split(":").pop() ?? "0")
            return total + (Number.isFinite(count) ? count : 0)
          }, 0),
          filenames: page,
          appliedOffset: offset,
          appliedLimit: headLimit === 0 ? undefined : headLimit,
        }
      }
      const result = await runRg([...args, "-l", pattern, relativeTarget], context.rootDir)
      const matches = result.stdout.split("\n").map(line => line.trim()).filter(Boolean)
      const page = headLimit === 0 ? matches.slice(offset) : matches.slice(offset, offset + headLimit)
      return {
        mode: "files_with_matches",
        numFiles: page.length,
        filenames: page,
        appliedOffset: offset,
        appliedLimit: headLimit === 0 ? undefined : headLimit,
      }
    },
  },
  {
    name: "Bash",
    aliases: ["bash"],
    description: "Execute a shell command locally from the workspace. Optional: run_in_background=true for long-running commands.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number" },
        run_in_background: { type: "boolean" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => typeof input.command === "string" && input.command.trim().length > 0 ? null : "command must be a non-empty string",
    async run(input, context) {
      const command = requireString(input, "command")
      const timeout = optionalNumber(input, "timeout") ?? DEFAULT_BASH_TIMEOUT_MS
      const runInBackground = optionalBoolean(input, "run_in_background") ?? false
      const shell = process.env.SHELL || "/bin/zsh"
      if (runInBackground) {
        const taskId = randomUUID()
        const paths = ensureDirs(context.rootDir)
        const outputPath = join(paths.logsDir, `background-${taskId}.log`)
        const stdout = openSync(outputPath, "a")
        const stderr = openSync(outputPath, "a")
        const child = spawn(shell, ["-lc", command], {
          cwd: context.cwd,
          detached: true,
          stdio: ["ignore", stdout, stderr],
          env: process.env,
        })
        child.unref()
        return {
          background: true,
          taskId,
          pid: child.pid,
          outputPath,
          command,
        }
      }
      try {
        const result = await execFileAsync(shell, ["-lc", command], {
          cwd: context.cwd,
          timeout,
          maxBuffer: MAX_EXEC_BUFFER,
          env: process.env,
        })
        return {
          command,
          cwd: context.cwd,
          stdout: result.stdout,
          stderr: result.stderr,
          interrupted: false,
          exitCode: 0,
        }
      } catch (error) {
        const typed = error as Error & { code?: number | string; killed?: boolean; stdout?: string; stderr?: string }
        return {
          command,
          cwd: context.cwd,
          stdout: typed.stdout ?? "",
          stderr: typed.stderr ?? typed.message,
          interrupted: typed.killed ?? false,
          exitCode: typeof typed.code === "number" ? typed.code : null,
        }
      }
    },
  },
  {
    name: "ListMcpResourcesTool",
    aliases: ["mcp_list_resources"],
    description: "List resources exposed by an MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
      },
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const server = optionalString(input, "server") ?? "demo"
      const client = await getMcpClient(context, server)
      return {
        server,
        resources: await client.listResources(),
      }
    },
  },
  {
    name: "ReadMcpResourceTool",
    aliases: ["mcp_read_resource"],
    description: "Read a specific MCP resource by URI.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        uri: { type: "string" },
      },
      required: ["uri"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => typeof input.uri === "string" && input.uri.length > 0 ? null : "uri must be a non-empty string",
    async run(input, context) {
      const server = optionalString(input, "server") ?? "demo"
      const uri = requireString(input, "uri")
      const client = await getMcpClient(context, server)
      return {
        server,
        uri,
        resource: await client.readResource(uri),
      }
    },
  },
  {
    name: "WebFetch",
    description: "Fetch a URL and extract content relevant to a prompt.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["url", "prompt"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.url !== "string" || !input.url.length) return "url must be a non-empty string"
      try { new URL(input.url) } catch { return "url must be a valid URL" }
      if (typeof input.prompt !== "string") return "prompt must be a string"
      return null
    },
    async run(input) {
      const url = requireString(input, "url")
      const prompt = requireString(input, "prompt")
      const startedAt = Date.now()
      let code = 0
      let codeText = ""
      let bytes = 0
      let content = ""
      try {
        try {
          const response = await fetch(url, {
            headers: {
              "User-Agent": "MonolitoV2/1.0",
              "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
            },
            signal: AbortSignal.timeout(15000),
          })
          code = response.status
          codeText = response.statusText
          const buffer = await response.arrayBuffer()
          bytes = buffer.byteLength
          const decoder = new TextDecoder("utf-8", { fatal: false })
          content = decoder.decode(buffer)
        } catch {
          const fallback = await fetchWithCurl(url)
          code = fallback.code
          codeText = fallback.codeText
          bytes = fallback.bytes
          content = fallback.content
        }
        // Strip HTML tags for plain text
        content = content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return {
          url,
          prompt,
          error: msg,
          durationMs: Date.now() - startedAt,
        }
      }
      const truncated = content.length > 5000 ? content.slice(0, 5000) + "..." : content
      const relevant = truncated.toLowerCase().includes(prompt.toLowerCase())
        ? `[Content relevant to "${prompt}"]\n${truncated}`
        : truncated
      return {
        url,
        bytes,
        code,
        codeText,
        result: relevant,
        durationMs: Date.now() - startedAt,
      }
    },
  },
  {
    name: "TodoWrite",
    description: "Add a task to the session task list. Tasks are private to the current profile and session.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        status: { type: "string", enum: ["in_progress", "completed", "pending"] },
      },
      required: ["content"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const content = requireString(input, "content")
      const status = optionalString(input, "status") ?? "pending"
      const profileId = context.profileId || "default"
      const paths = getPaths(context.rootDir, profileId)
      const taskFile = join(paths.profilesDir, profileId, "tasks.json")
      
      let tasks: Array<{ id: string; content: string; status: string; createdAt: string; sessionId?: string }> = []
      try {
        if (existsSync(taskFile)) {
          tasks = JSON.parse(readFileSync(taskFile, "utf8"))
        }
      } catch {}
      
      const task = {
        id: randomUUID().slice(0, 8),
        sessionId: (context as any).sessionId,
        content,
        status,
        createdAt: new Date().toISOString(),
      }
      tasks.push(task)
      mkdirSync(dirname(taskFile), { recursive: true })
      writeFileSync(taskFile, JSON.stringify(tasks, null, 2))
      return { task, total: tasks.length, profile: profileId }
    },
  },
  {
    name: "TelegramSend",
    aliases: ["telegram_send"],
    description: "Send a message to a Telegram chat. Requires Telegram to be configured and enabled via /channels.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "The Telegram chat ID to send the message to." },
        text: { type: "string", description: "The text message to send." },
        parse_mode: { type: "string", enum: ["Markdown", "MarkdownV2", "HTML"], description: "Optional parse mode for formatting." },
      },
      required: ["chat_id", "text"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.chat_id !== "number") return "chat_id must be a number"
      if (typeof input.text !== "string" || input.text.length === 0) return "text must be a non-empty string"
      return null
    },
    async run(input) {
      const chatId = input.chat_id as number
      const text = input.text as string
      const parseMode = optionalString(input, "parse_mode")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const body: Record<string, unknown> = { chat_id: chatId, text }
      if (parseMode) body.parse_mode = parseMode
      const response = await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      const data = await response.json() as { ok: boolean; result?: unknown; description?: string }
      if (!data.ok) {
        throw new Error(`Telegram API error: ${data.description ?? response.status}`)
      }
      return { ok: true, chat_id: chatId, message: data.result }
    },
  },
  {
    name: "TelegramSendPhoto",
    description: "Send a photo to a Telegram chat. Accepts a Telegram file_id, an HTTP URL, or a local file path.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "The Telegram chat ID to send the photo to." },
        photo: { type: "string", description: "Telegram file_id, HTTP URL, or local file path." },
        caption: { type: "string", description: "Optional caption for the photo." },
        parse_mode: { type: "string", enum: ["Markdown", "MarkdownV2", "HTML"], description: "Optional parse mode for the caption." },
      },
      required: ["chat_id", "photo"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.chat_id !== "number") return "chat_id must be a number"
      if (typeof input.photo !== "string" || input.photo.length === 0) return "photo must be a non-empty string"
      return null
    },
    async run(input) {
      const chatId = input.chat_id as number
      const photo = requireString(input, "photo")
      const caption = optionalString(input, "caption")
      const parseMode = optionalString(input, "parse_mode")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const params: Record<string, unknown> = { chat_id: chatId, photo }
      if (caption) params.caption = caption
      if (parseMode) params.parse_mode = parseMode
      const data = isLocalPath(photo)
        ? await telegramApiCallWithFile(config.telegram.token, "sendPhoto", "photo", photo, params)
        : await telegramApiCall(config.telegram.token, "sendPhoto", params)
      if (!data.ok) throw new Error(`Telegram API error: ${data.description ?? "sendPhoto failed"}`)
      return { ok: true, chat_id: chatId, message: data.result }
    },
  },
  {
    name: "TelegramSendDocument",
    description: "Send a document to a Telegram chat. Accepts a Telegram file_id, an HTTP URL, or a local file path.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "The Telegram chat ID to send the document to." },
        document: { type: "string", description: "Telegram file_id, HTTP URL, or local file path." },
        caption: { type: "string", description: "Optional caption for the document." },
      },
      required: ["chat_id", "document"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.chat_id !== "number") return "chat_id must be a number"
      if (typeof input.document !== "string" || input.document.length === 0) return "document must be a non-empty string"
      return null
    },
    async run(input) {
      const chatId = input.chat_id as number
      const document = requireString(input, "document")
      const caption = optionalString(input, "caption")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const params: Record<string, unknown> = { chat_id: chatId, document }
      if (caption) params.caption = caption
      const data = isLocalPath(document)
        ? await telegramApiCallWithFile(config.telegram.token, "sendDocument", "document", document, params)
        : await telegramApiCall(config.telegram.token, "sendDocument", params)
      if (!data.ok) throw new Error(`Telegram API error: ${data.description ?? "sendDocument failed"}`)
      return { ok: true, chat_id: chatId, message: data.result }
    },
  },
  {
    name: "TelegramGetFile",
    description: "Resolve a Telegram file_id into Telegram file metadata and a downloadable file_path.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The Telegram file_id to inspect." },
      },
      required: ["file_id"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => typeof input.file_id === "string" && input.file_id.length > 0 ? null : "file_id must be a non-empty string",
    async run(input) {
      const fileId = requireString(input, "file_id")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const data = await telegramApiCall(config.telegram.token, "getFile", { file_id: fileId })
      if (!data.ok) throw new Error(`Telegram API error: ${data.description ?? "getFile failed"}`)
      return { ok: true, file: data.result }
    },
  },
  {
    name: "TelegramDownloadFile",
    description: "Download a Telegram file_id into Monolito scratchpad storage and return the local path.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The Telegram file_id to download." },
        filename: { type: "string", description: "Optional local filename override." },
      },
      required: ["file_id"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => typeof input.file_id === "string" && input.file_id.length > 0 ? null : "file_id must be a non-empty string",
    async run(input, context) {
      const fileId = requireString(input, "file_id")
      const filename = optionalString(input, "filename")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      return await resolveTelegramDownload(config.telegram.token, fileId, context.rootDir, filename)
    },
  },
  {
    name: "TodoList",
    description: "List tasks for the current agent profile and session.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["all", "pending", "in_progress", "completed"] },
      },
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const filter = optionalString(input, "filter") ?? "all"
      const profileId = context.profileId || "default"
      const sessionId = (context as any).sessionId
      const paths = getPaths(context.rootDir, profileId)
      const taskFile = join(paths.profilesDir, profileId, "tasks.json")
      
      let tasks: Array<{ id: string; content: string; status: string; createdAt: string; sessionId?: string }> = []
      try {
        if (existsSync(taskFile)) {
          tasks = JSON.parse(readFileSync(taskFile, "utf8"))
        }
      } catch {}
      
      // Filter by session first
      let sessionTasks = sessionId ? tasks.filter(t => t.sessionId === sessionId) : tasks
      const filtered = filter === "all" ? sessionTasks : sessionTasks.filter(t => t.status === filter)
      
      return { 
        tasks: filtered, 
        totalInSession: sessionTasks.length, 
        totalInProfile: tasks.length,
        filter,
        profile: profileId
      }
    },
  },
  {
    name: "WorkspaceRead",
    description: "Read an injected core workspace file (SOUL, AGENTS, IDENTITY, USER, TOOLS, HEARTBEAT, BOOTSTRAP, MEMORY) without needing a path.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", enum: ["SOUL", "AGENTS", "IDENTITY", "USER", "TOOLS", "HEARTBEAT", "BOOTSTRAP", "MEMORY"] },
      },
      required: ["file"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const file = requireString(input, "file")
      const paths = getPaths(context.rootDir, context.profileId)
      const filePath = join(paths.workspaceDir, `${file}.md`)
      if (!existsSync(filePath)) throw new Error(`Workspace file ${file}.md not found in profile ${context.profileId ?? "default"}`)
      const content = readFileSync(filePath, "utf8")
      return { file, content, profile: context.profileId ?? "default" }
    },
  },
  {
    name: "WorkspaceWrite",
    description: "Update an injected core workspace file (SOUL, AGENTS, IDENTITY, USER, TOOLS, HEARTBEAT, BOOTSTRAP, MEMORY). Use this for durable identity, workspace rules, heartbeat/bootstrap instructions, or curated long-term notes.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", enum: ["SOUL", "AGENTS", "IDENTITY", "USER", "TOOLS", "HEARTBEAT", "BOOTSTRAP", "MEMORY"] },
        content: { type: "string" },
      },
      required: ["file", "content"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    async run(input, context) {
      const file = requireString(input, "file")
      const content = requireString(input, "content")
      const paths = getPaths(context.rootDir, context.profileId)
      const filePath = join(paths.workspaceDir, `${file}.md`)
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, content, "utf8")
      return { file, ok: true, bytes: Buffer.byteLength(content), profile: context.profileId ?? "default" }
    },
  },
  {
    name: "WorkspaceMemoryFiling",
    description: "Store facts, decisions, or snippets in the SQLite Memory Palace. Use wing='SHARED' for team-wide memory visible to every profile. Any other wing stays private to the current profile.",
    inputSchema: {
      type: "object",
      properties: {
        wing: { type: "string", description: "Wing name. Use 'SHARED' for global memory; any other wing is private to the current profile." },
        room: { type: "string", description: "Topical room within the wing (e.g. 'architecture', 'auth')." },
        key: { type: "string", description: "Optional stable key to group or retrieve a specific memory later." },
        content: { type: "string", description: "The raw verbatim detail or decision to save." },
      },
      required: ["wing", "room", "content"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    async run(input, context) {
      const wing = requireString(input, "wing")
      const room = requireString(input, "room")
      const key = optionalString(input, "key")
      const content = requireString(input, "content")
      const id = await fileMemory(context.rootDir, wing, room, content, context.profileId, key)
      return { ok: true, id, wing, room, key: key ?? null, shared: wing.trim().toUpperCase() === "SHARED" }
    },
  },
  {
    name: "WorkspaceMemoryRecall",
    description: "Recall memories from the SQLite Memory Palace. Results are limited to the current profile plus global SHARED memories. Calls without filters still respect that isolation.",
    inputSchema: {
      type: "object",
      properties: {
        wing: { type: "string", description: "Optional filter for a specific wing." },
        room: { type: "string", description: "Optional filter for a specific room to narrow down." },
        key: { type: "string", description: "Optional stable key filter for an exact memory group." },
        query: { type: "string", description: "Optional natural language query for deep semantic search." }
      },
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const wing = optionalString(input, "wing")
      const room = optionalString(input, "room")
      const key = optionalString(input, "key")
      const query = optionalString(input, "query")
      
      const results = await recallMemory(context.rootDir, wing, room, query, context.profileId, key)
      
      if (!wing && !room && !key && !query) {
        return {
          wings: listWings(context.rootDir, context.profileId),
          recentMemories: results
        }
      }
      if (wing && !room && !key && !query) {
        return {
          wing,
          rooms: listRooms(context.rootDir, wing, context.profileId),
          memories: results,
        }
      }
      return {
        wing,
        room,
        key,
        query,
        semanticSearchActive: !!query,
        memories: results
      }
    },
  },
  {
    name: "AgentSpawn",
    description: "Delegate a mission to a worker agent. Workers can run in parallel and report back autonomously. Use this for research, implementation, or verification.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", description: "The ID of the profile to use (e.g. 'coder', 'researcher')." },
        task: { type: "string", description: "The specific instructions for the agent." },
        description: { type: "string", description: "A brief name for this task (e.g. 'Fix auth bug')." },
        type: { type: "string", enum: ["worker", "researcher", "verifier"], description: "The specialization level of the agent." },
      },
      required: ["profileId", "task"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const profileId = requireString(input, "profileId")
      const task = requireString(input, "task")
      const description = optionalString(input, "description")
      const type = (optionalString(input, "type") as any) || "worker"
      
      if (!context.orchestrator) throw new Error("Agent Orchestrator not available.")
      
      const parentSessionId = (context as any).sessionId 
      if (!parentSessionId) throw new Error("Parent Session ID not found.")

      const spawned = await context.orchestrator.spawnAgent(parentSessionId, profileId, task, description, type)
      if (spawned.status === "failed") {
        return {
          ok: false,
          agentId: spawned.agentId,
          status: "failed",
          error: spawned.error ?? "Agent failed immediately after spawn.",
          message: `Agent '${description || spawned.agentId}' failed immediately.`,
        }
      }
      if (spawned.status === "completed") {
        return {
          ok: true,
          agentId: spawned.agentId,
          status: "completed",
          result: spawned.result ?? "",
          message: `Agent '${description || spawned.agentId}' completed immediately.`,
        }
      }
      if (spawned.status === "killed") {
        return {
          ok: false,
          agentId: spawned.agentId,
          status: "killed",
          error: spawned.error ?? "Agent was stopped.",
          message: `Agent '${description || spawned.agentId}' was stopped immediately.`,
        }
      }
      return {
        ok: true,
        agentId: spawned.agentId,
        status: "spawned",
        message: `Agent '${description || spawned.agentId}' started asynchronously. Do not claim completion or worker results until a <task-notification> confirms them.`,
      }
    },
  },
  {
    name: "AgentSendMessage",
    description: "Send a follow-up message to an existing sub-agent to continue its work, correct its path, or give new instructions.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "The taskId/agentId of the agent to message." },
        message: { type: "string", description: "The follow-up instructions." },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const to = requireString(input, "to")
      const message = requireString(input, "message")
      if (!context.orchestrator) throw new Error("Agent Orchestrator not available.")
      await context.orchestrator.sendMessageToAgent(to, message)
      return { ok: true, message: `Message sent to agent ${to}.` }
    },
  },
  {
    name: "AgentStop",
    description: "Stop a running agent task immediately.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The ID of the agent to stop." },
      },
      required: ["agentId"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const agentId = requireString(input, "agentId")
      if (!context.orchestrator) throw new Error("Agent Orchestrator not available.")
      await context.orchestrator.stopAgent(agentId)
      return { ok: true, message: `Agent ${agentId} stopped.` }
    },
  },
  {
    name: "AgentList",
    description: "List available agent profiles that can be used for delegation.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run(_input, context) {
      return { profiles: listProfiles(context.rootDir) }
    },
  },
  {
    name: "ProfileCreate",
    description: "Create a new agent profile with its own identity and workspace.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The unique ID for the profile (e.g. 'coder')." },
        name: { type: "string", description: "Human-friendly name (e.g. 'Expert Coder')." },
        description: { type: "string", description: "Brief description of the agent's purpose." },
      },
      required: ["id", "name"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const id = requireString(input, "id")
      const name = requireString(input, "name")
      const description = optionalString(input, "description")
      
      const newId = createProfile(context.rootDir, id, name, description)
      ensureDirs(context.rootDir, newId) // Initializes files
      
      return { ok: true, id: newId, status: "profile_created" }
    },
  },
  // --- ImageSearch via SearxNG Docker ---
  {
    name: "ImageSearch",
    description: "Search for images on the internet via SearxNG. Auto-deploys SearxNG Docker container if not running (localhost only). Returns image URLs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for images. Be direct and specific." },
        limit: { type: "number", description: "Max number of image URLs to return (default 5)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input) {
      const query = requireString(input, "query")
      const limit = optionalNumber(input, "limit") ?? 5
      const SEARXNG_PORT = 18890
      const SEARXNG_URL = `http://127.0.0.1:${SEARXNG_PORT}`
      const CONTAINER_NAME = "monolito-searxng"

      // 1. Check if SearxNG is reachable
      let alive = false
      try {
        const probe = await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(3000) })
        alive = probe.ok
      } catch {}

      // 2. If not alive, ensure Docker container is running
      if (!alive) {
        // Check if container exists but stopped
        try {
          const { stdout: psOut } = await execFileAsync("docker", ["ps", "-a", "--filter", `name=${CONTAINER_NAME}`, "--format", "{{.Status}}"], { timeout: 10_000 })
          const status = psOut.trim()
          if (status && !status.startsWith("Up")) {
            // Container exists but not running — start it
            await execFileAsync("docker", ["start", CONTAINER_NAME], { timeout: 15_000 })
          } else if (!status) {
            // Container doesn't exist — create and run
            await execFileAsync("docker", [
              "run", "-d",
              "--name", CONTAINER_NAME,
              "-p", `127.0.0.1:${SEARXNG_PORT}:8080`,
              "--restart", "unless-stopped",
              "searxng/searxng:latest",
            ], { timeout: 60_000 })
          }
        } catch (dockerErr) {
          const msg = dockerErr instanceof Error ? dockerErr.message : String(dockerErr)
          return { ok: false, error: `Failed to start SearxNG container: ${msg}` }
        }

        // Wait for SearxNG to become ready (up to 20s)
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1000))
          try {
            const probe = await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(2000) })
            if (probe.ok) { alive = true; break }
          } catch {}
        }
        if (!alive) {
          return { ok: false, error: "SearxNG container started but did not become healthy within 20s." }
        }
      }

      // 3. Search
      const encoded = encodeURIComponent(query)
      const searchUrl = `${SEARXNG_URL}/search?q=${encoded}&categories=images&format=json`
      try {
        const res = await fetch(searchUrl, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) {
          return { ok: false, error: `SearxNG returned HTTP ${res.status}` }
        }
        const data = await res.json() as { results?: Array<{ img_src?: string; title?: string; source?: string; thumbnail_src?: string }> }
        const results = (data.results ?? [])
          .filter(r => r.img_src)
          .slice(0, limit)
          .map(r => ({ url: r.img_src, title: r.title, source: r.source, thumbnail: r.thumbnail_src }))

        return { ok: true, query, count: results.length, results }
      } catch (searchErr) {
        const msg = searchErr instanceof Error ? searchErr.message : String(searchErr)
        return { ok: false, error: `Search failed: ${msg}` }
      }
    },
  },
]

export function listTools() {
  return tools
}

export function listModelTools() {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))
}

export function getTool(name: string) {
  const normalized = name.toLowerCase()
  return tools.find(tool =>
    tool.name.toLowerCase() === normalized ||
    tool.aliases?.some(alias => alias.toLowerCase() === normalized),
  ) ?? null
}

export function validateToolInput(name: string, input: Record<string, unknown>) {
  const tool = getTool(name)
  if (!tool) return `Unknown tool: ${name}`
  return tool.validate?.(input) ?? null
}

export function isToolConcurrencySafe(name: string, input: Record<string, unknown>) {
  const tool = getTool(name)
  if (!tool) return false
  if (typeof tool.concurrencySafe === "function") return tool.concurrencySafe(input)
  return tool.concurrencySafe === true
}
