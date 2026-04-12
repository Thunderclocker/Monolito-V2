import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { ensureDirs, getPaths } from "../ipc/protocol.ts"
import { MONOLITO_ROOT } from "../system/root.ts"
import { type StdioMcpClient, getDefaultMcpServers } from "../mcp/client.ts"
import { normalizeChannelsConfig, readChannelsConfig } from "../channels/config.ts"
import { fileMemory, recallMemory, listWings, listRooms, listProfiles, createProfile, readBootWing, writeBootWing, ensureBootWings, readConfigWing, writeConfigWing, appendActionLog } from "../session/store.ts"
import { type AgentOrchestrator } from "../runtime/orchestrator.ts"
import { type Logger } from "../logging/logger.ts"
import { BOOT_WING_ORDER, isBootWingName } from "../bootstrap/bootWings.ts"
import { CONFIG_WING_ORDER, type ConfigWingName } from "../config/configWings.ts"
import { coerceConfigRecord } from "../config/wingValue.ts"
import { loadAndApplyModelSettings } from "../runtime/modelConfig.ts"
import {
  deployManagedTtsContainer,
  getManagedTtsBaseUrl,
  getManagedTtsStatus,
  listManagedTtsContainers,
  normalizeTtsConfig,
  removeManagedTtsContainer,
  stopManagedTtsContainer,
} from "../tts/managed.ts"
import {
  deployManagedSttContainer,
  getManagedSttBaseUrl,
  getManagedSttStatus,
  listManagedSttContainers,
  normalizeSttConfig,
  removeManagedSttContainer,
  stopManagedSttContainer,
  transcribeManagedAudioFile,
} from "../stt/managed.ts"

const execFileAsync = promisify(execFile)
const DEFAULT_GREP_LIMIT = 250
const DEFAULT_BASH_TIMEOUT_MS = 120_000
const MAX_EXEC_BUFFER = 4 * 1024 * 1024
const TELEGRAM_AUDIO_FORMATS = new Set(["mp3", "m4a", "aac"])
const TELEGRAM_VOICE_FORMATS = new Set(["ogg", "opus"])
const TTS_RESPONSE_FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"])

export type ToolContext = {
  rootDir: string
  cwd: string
  profileId?: string
  getMcpClient?: (serverName: string) => Promise<StdioMcpClient>
  orchestrator?: AgentOrchestrator
  logger?: Logger
  sessionId?: string
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
  const allowedRoots = [resolve(rootDir), resolve(MONOLITO_ROOT)]
  const absolute = resolve(cwd, target)
  const allowed = allowedRoots.some(root => absolute === root || absolute.startsWith(`${root}${sep}`))
  if (!allowed) {
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

function normalizeConfigWingValue(wing: ConfigWingName, value: unknown) {
  if (wing === "CONF_CHANNELS") {
    return normalizeChannelsConfig(value)
  }
  if (wing === "CONF_MODELS" || wing === "CONF_SYSTEM" || wing === "CONF_WEBSEARCH") {
    return coerceConfigRecord(value) ?? value
  }
  return value
}

function inferExtensionFromFormat(format: string) {
  if (format === "opus") return "ogg"
  return format
}

function sanitizeFilenameSegment(value: string) {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-")
  return normalized.replace(/^-+|-+$/g, "") || "speech"
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
      const instanceLogPath = context.logger?.logPath
      if (runInBackground) {
        const taskId = randomUUID()
        const paths = ensureDirs(context.rootDir)
        const outputPath = instanceLogPath ?? join(paths.logsDir, `background-${taskId}.log`)
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
      if (instanceLogPath) {
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        const outputStream = createWriteStream(instanceLogPath, { flags: "a" })
        const child = spawn(shell, ["-lc", command], {
          cwd: context.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        })
        const timeoutId = setTimeout(() => {
          child.kill("SIGKILL")
        }, timeout)
        child.stdout?.on("data", chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
          stdoutChunks.push(buffer)
          outputStream.write(buffer)
        })
        child.stderr?.on("data", chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
          stderrChunks.push(buffer)
          outputStream.write(buffer)
        })
        const exitCode = await new Promise<number | null>(resolve => {
          child.on("close", code => resolve(code === null ? null : code))
        })
        clearTimeout(timeoutId)
        outputStream.end()
        return {
          command,
          cwd: context.cwd,
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
          interrupted: exitCode === null,
          exitCode,
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
    name: "SttServiceStatus",
    aliases: ["stt_service_status"],
    description: "Show the status of the managed local speech-to-text service container.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run() {
      const config = readChannelsConfig()
      const stt = normalizeSttConfig(config.stt)
      const status = await getManagedSttStatus(stt)
      return {
        managed: stt.managed,
        auto_deploy: stt.autoDeploy,
        auto_transcribe: stt.autoTranscribe,
        status,
        base_url: getManagedSttBaseUrl(stt),
        container_name: stt.containerName,
        image: stt.image,
        port: stt.port,
        engine: stt.engine,
        model: stt.model,
      }
    },
  },
  {
    name: "SttServiceDeploy",
    aliases: ["stt_service_deploy"],
    description: "Deploy or restart the managed local speech-to-text service container using Docker. Cleans conflicting legacy Whisper containers first.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const stt = normalizeSttConfig(config.stt)
      return await deployManagedSttContainer(stt)
    },
  },
  {
    name: "SttServiceStop",
    aliases: ["stt_service_stop"],
    description: "Stop the managed local speech-to-text service container without deleting it.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const stt = normalizeSttConfig(config.stt)
      return await stopManagedSttContainer(stt)
    },
  },
  {
    name: "SttServiceRemove",
    aliases: ["stt_service_remove"],
    description: "Remove the managed local speech-to-text service container and conflicting legacy Whisper containers when found.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const stt = normalizeSttConfig(config.stt)
      return await removeManagedSttContainer(stt)
    },
  },
  {
    name: "SttServiceList",
    aliases: ["stt_service_list"],
    description: "List detected local speech-to-text service containers related to the managed image or container name, including legacy Whisper containers.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run() {
      const config = readChannelsConfig()
      const stt = normalizeSttConfig(config.stt)
      return { message: await listManagedSttContainers(stt) }
    },
  },
  {
    name: "TranscribeAudio",
    aliases: ["transcribe_audio"],
    description: "Transcribe a local audio file using the managed speech-to-text backend. Deploys the service automatically when configured.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Local path to the audio file to transcribe." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => typeof input.path === "string" && input.path.length > 0 ? null : "path must be a non-empty string",
    async run(input) {
      const path = requireString(input, "path")
      const config = readChannelsConfig()
      const stt = normalizeSttConfig(config.stt)
      if (stt.managed && stt.autoDeploy) {
        const deploy = await deployManagedSttContainer(stt)
        if (!deploy.ok) throw new Error(deploy.message)
      }
      const result = await transcribeManagedAudioFile(path, stt)
      if (!result.ok) throw new Error(result.error ?? "STT transcription failed")
      return result
    },
  },
  {
    name: "TtsServiceStatus",
    aliases: ["tts_service_status"],
    description: "Show the status of the managed local TTS service container.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run() {
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      const status = await getManagedTtsStatus(tts)
      return {
        managed: tts.managed,
        auto_deploy: tts.autoDeploy,
        status,
        base_url: getManagedTtsBaseUrl(tts),
        container_name: tts.containerName,
        image: tts.image,
        port: tts.port,
      }
    },
  },
  {
    name: "TtsServiceDeploy",
    aliases: ["tts_service_deploy"],
    description: "Deploy or restart the managed local TTS service container using Docker. Cleans conflicting legacy OpenAI Edge TTS containers first.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      return await deployManagedTtsContainer(tts)
    },
  },
  {
    name: "TtsServiceStop",
    aliases: ["tts_service_stop"],
    description: "Stop the managed local TTS service container without deleting it.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      return await stopManagedTtsContainer(tts)
    },
  },
  {
    name: "TtsServiceRemove",
    aliases: ["tts_service_remove"],
    description: "Remove the managed local TTS service container. Also removes conflicting legacy OpenAI Edge TTS containers when found.",
    inputSchema: emptyInputSchema,
    concurrencySafe: false,
    async run() {
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      return await removeManagedTtsContainer(tts)
    },
  },
  {
    name: "TtsServiceList",
    aliases: ["tts_service_list"],
    description: "List detected local TTS service containers related to the managed image or container name, including legacy OpenAI Edge TTS containers such as tts-edge.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run() {
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      return { message: await listManagedTtsContainers(tts) }
    },
  },
  {
    name: "GenerateSpeech",
    aliases: ["generate_speech", "tts_generate"],
    description: "Generate a speech audio file with the configured OpenAI-compatible TTS backend and save it to Monolito scratchpad storage.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to synthesize into speech." },
        base_url: { type: "string", description: "Optional TTS base URL override. The tool will call <base_url>/v1/audio/speech." },
        api_key: { type: "string", description: "Optional TTS API key override." },
        voice: { type: "string", description: "Optional voice override, for example es-AR-ElenaNeural." },
        model: { type: "string", description: "Optional TTS model override, for example tts-1." },
        response_format: { type: "string", enum: ["mp3", "opus", "aac", "flac", "wav", "pcm"], description: "Optional audio format override." },
        speed: { type: "number", description: "Optional playback speed override. Typical range 0.25 to 4.0." },
        filename: { type: "string", description: "Optional filename without directory. Saved under Monolito scratchpad." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    validate: input => {
      if (typeof input.text !== "string" || input.text.trim().length === 0) return "text must be a non-empty string"
      const speed = optionalNumber(input, "speed")
      if (speed !== undefined && (speed <= 0 || speed > 4)) return "speed must be between 0 and 4"
      const format = optionalString(input, "response_format")
      if (format && !TTS_RESPONSE_FORMATS.has(format)) return "response_format must be one of: mp3, opus, aac, flac, wav, pcm"
      return null
    },
    async run(input, context) {
      const text = requireString(input, "text")
      const config = readChannelsConfig()
      const tts = normalizeTtsConfig(config.tts)
      let baseUrl = (optionalString(input, "base_url") ?? tts.baseUrl).replace(/\/+$/g, "")
      if (tts.managed) {
        baseUrl = getManagedTtsBaseUrl(tts)
        if (tts.autoDeploy) {
          const deploy = await deployManagedTtsContainer(tts)
          if (!deploy.ok) throw new Error(deploy.message)
        }
      }
      if (!baseUrl) {
        throw new Error("TTS base URL is not configured. Use /config set tts_base_url <value> or enable managed TTS.")
      }

      const voice = optionalString(input, "voice") ?? tts.voice
      const model = optionalString(input, "model") ?? tts.model
      const responseFormat = optionalString(input, "response_format") ?? tts.responseFormat
      const speed = optionalNumber(input, "speed") ?? tts.speed
      const apiKey = optionalString(input, "api_key") ?? tts.apiKey
      const paths = ensureDirs(context.rootDir, context.profileId)
      const speechDir = join(paths.scratchpadDir, "tts")
      mkdirSync(speechDir, { recursive: true })

      const extension = inferExtensionFromFormat(responseFormat)
      const requestedFilename = optionalString(input, "filename")
      const filename = requestedFilename
        ? sanitizeFilenameSegment(requestedFilename.replace(/\.[^.]+$/, ""))
        : `${sanitizeFilenameSegment(voice)}-${randomUUID().slice(0, 8)}`
      const localPath = join(speechDir, `${filename}.${extension}`)

      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const response = await fetch(`${baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          input: text,
          voice,
          response_format: responseFormat,
          speed,
        }),
        signal: AbortSignal.timeout(60_000),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`TTS request failed: HTTP ${response.status}${body ? ` - ${body.slice(0, 400)}` : ""}`)
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      writeFileSync(localPath, buffer)

      return {
        ok: true,
        local_path: localPath,
        bytes: buffer.length,
        voice,
        model,
        response_format: responseFormat,
        speed,
      }
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
    name: "TelegramSendAudio",
    aliases: ["telegram_send_audio"],
    description: "Send an audio file to a Telegram chat. Accepts a Telegram file_id, an HTTP URL, or a local file path. Local files should usually be mp3, m4a, or aac.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "The Telegram chat ID to send the audio to." },
        audio: { type: "string", description: "Telegram file_id, HTTP URL, or local file path." },
        caption: { type: "string", description: "Optional caption for the audio." },
        title: { type: "string", description: "Optional title shown by Telegram." },
        performer: { type: "string", description: "Optional performer shown by Telegram." },
      },
      required: ["chat_id", "audio"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.chat_id !== "number") return "chat_id must be a number"
      if (typeof input.audio !== "string" || input.audio.length === 0) return "audio must be a non-empty string"
      if (isLocalPath(input.audio) && !TELEGRAM_AUDIO_FORMATS.has((input.audio.split(".").pop() ?? "").toLowerCase())) {
        return "local audio files should use mp3, m4a, or aac"
      }
      return null
    },
    async run(input) {
      const chatId = input.chat_id as number
      const audio = requireString(input, "audio")
      const caption = optionalString(input, "caption")
      const title = optionalString(input, "title")
      const performer = optionalString(input, "performer")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const params: Record<string, unknown> = { chat_id: chatId, audio }
      if (caption) params.caption = caption
      if (title) params.title = title
      if (performer) params.performer = performer
      const data = isLocalPath(audio)
        ? await telegramApiCallWithFile(config.telegram.token, "sendAudio", "audio", audio, params)
        : await telegramApiCall(config.telegram.token, "sendAudio", params)
      if (!data.ok) throw new Error(`Telegram API error: ${data.description ?? "sendAudio failed"}`)
      return { ok: true, chat_id: chatId, message: data.result }
    },
  },
  {
    name: "TelegramSendVoice",
    aliases: ["telegram_send_voice"],
    description: "Send a voice note to a Telegram chat. Accepts a Telegram file_id, an HTTP URL, or a local file path. Local files should usually be ogg or opus.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "The Telegram chat ID to send the voice note to." },
        voice: { type: "string", description: "Telegram file_id, HTTP URL, or local file path." },
        caption: { type: "string", description: "Optional caption for the voice note." },
      },
      required: ["chat_id", "voice"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    validate: input => {
      if (typeof input.chat_id !== "number") return "chat_id must be a number"
      if (typeof input.voice !== "string" || input.voice.length === 0) return "voice must be a non-empty string"
      if (isLocalPath(input.voice) && !TELEGRAM_VOICE_FORMATS.has((input.voice.split(".").pop() ?? "").toLowerCase())) {
        return "local voice files should use ogg or opus"
      }
      return null
    },
    async run(input) {
      const chatId = input.chat_id as number
      const voice = requireString(input, "voice")
      const caption = optionalString(input, "caption")
      const config = readChannelsConfig()
      if (!config.telegram?.enabled || !config.telegram.token) {
        throw new Error("Telegram is not configured or not enabled. Use /channels to set it up.")
      }
      const params: Record<string, unknown> = { chat_id: chatId, voice }
      if (caption) params.caption = caption
      const data = isLocalPath(voice)
        ? await telegramApiCallWithFile(config.telegram.token, "sendVoice", "voice", voice, params)
        : await telegramApiCall(config.telegram.token, "sendVoice", params)
      if (!data.ok) throw new Error(`Telegram API error: ${data.description ?? "sendVoice failed"}`)
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
    name: "BootRead",
    description: "Read a deterministic BOOT wing from SQLite without relying on legacy workspace files.",
    inputSchema: {
      type: "object",
      properties: {
        wing: { type: "string", enum: [...BOOT_WING_ORDER] },
      },
      required: ["wing"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const wing = requireString(input, "wing")
      if (!isBootWingName(wing)) throw new Error(`Unsupported BOOT wing: ${wing}`)
      ensureBootWings(context.rootDir, context.profileId ?? "default")
      const content = readBootWing(context.rootDir, wing, context.profileId ?? "default")
      if (content == null) throw new Error(`BOOT wing ${wing} not found in profile ${context.profileId ?? "default"}`)
      return { wing, content, profile: context.profileId ?? "default" }
    },
  },
  {
    name: "BootWrite",
    description: "Replace the canonical content of a deterministic BOOT wing in SQLite.",
    inputSchema: {
      type: "object",
      properties: {
        wing: { type: "string", enum: [...BOOT_WING_ORDER] },
        content: { type: "string" },
      },
      required: ["wing", "content"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    async run(input, context) {
      const wing = requireString(input, "wing")
      const content = requireString(input, "content")
      if (!isBootWingName(wing)) throw new Error(`Unsupported BOOT wing: ${wing}`)
      const result = writeBootWing(context.rootDir, wing, content, context.profileId ?? "default")
      return { wing, ok: true, changed: result.changed, bytes: result.bytes, profile: context.profileId ?? "default" }
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
    name: "delegate_background_task",
    description: "Delegate a heavy task to a background worker and return immediately with a job_id.",
    inputSchema: {
      type: "object",
      properties: {
        task_instruction: { type: "string", description: "Detailed instructions for the background worker." },
        description: { type: "string", description: "Short label for this task." },
        profileId: { type: "string", description: "Optional profile to run the worker under." },
      },
      required: ["task_instruction"],
      additionalProperties: false,
    },
    concurrencySafe: true,
    async run(input, context) {
      const task = requireString(input, "task_instruction")
      const description = optionalString(input, "description")
      const profileId = optionalString(input, "profileId") ?? context.profileId ?? "default"

      if (!context.orchestrator) throw new Error("Agent Orchestrator not available.")
      const parentSessionId = (context as any).sessionId
      if (!parentSessionId) throw new Error("Parent Session ID not found.")

      const spawned = await context.orchestrator.spawnBackgroundTask(parentSessionId, profileId, task, description)
      return {
        ok: spawned.status !== "failed" && spawned.status !== "killed",
        job_id: spawned.agentId,
        status: spawned.status,
        result: spawned.result ?? "",
        error: spawned.error,
        message: spawned.status === "spawned"
          ? "Background worker started. You will be notified when it completes."
          : "Background worker finished immediately.",
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
      ensureDirs(context.rootDir, newId)
      ensureBootWings(context.rootDir, newId)
      
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
      const SEARXNG_PORT = 8888
      const SEARXNG_URL = `http://127.0.0.1:${SEARXNG_PORT}`
      const CONTAINER_NAME = "monolito-searxng"
      const SETTINGS_DIR = join(MONOLITO_ROOT, "searxng")
      const SETTINGS_FILE = join(SETTINGS_DIR, "settings.yml")

      type SearxngContainerInfo = {
        id: string
        name: string
        image: string
        status: string
        isOurs: boolean
      }

      async function findAllSearxngContainers(): Promise<SearxngContainerInfo[]> {
        try {
          const { stdout: byImage } = await execFileAsync("docker", [
            "ps", "-a",
            "--filter", "ancestor=searxng/searxng",
            "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
          ], { timeout: 10_000 })
          const { stdout: byName } = await execFileAsync("docker", [
            "ps", "-a",
            "--filter", "name=searxng",
            "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
          ], { timeout: 10_000 })

          const seen = new Set<string>()
          const containers: SearxngContainerInfo[] = []
          for (const line of [...byImage.trim().split("\n"), ...byName.trim().split("\n")]) {
            if (!line.trim()) continue
            const [id, name, image, status] = line.split("\t")
            if (!id || seen.has(id)) continue
            seen.add(id)
            containers.push({
              id: id.slice(0, 12),
              name: name ?? "",
              image: image ?? "",
              status: status ?? "",
              isOurs: name === CONTAINER_NAME,
            })
          }
          return containers
        } catch {
          return []
        }
      }

      async function waitForHealthy(seconds: number) {
        for (let i = 0; i < seconds; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000))
          try {
            const probe = await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(2000) })
            if (probe.ok) return true
          } catch {}
        }
        return false
      }

      function withManagedSearxngSettings(content: string) {
        let updated = content
        if (!/^\s*-\s*json\s*$/m.test(updated)) {
          updated = updated.replace(/(^\s*formats:\n(?:\s*#.*\n)*\s*-\s*html\s*$)/m, `$1\n    - json`)
        }
        if (/^\s*safe_search:\s*0\s*$/m.test(updated)) return updated
        if (/^\s*safe_search:\s*\d+\s*$/m.test(updated)) {
          return updated.replace(/^(\s*safe_search:\s*)\d+\s*$/m, (_, prefix: string) => `${prefix}0`)
        }
        if (/^\s*search:\s*$/m.test(updated)) {
          return updated.replace(/^(\s*search:\s*)$/m, "$1\n  safe_search: 0")
        }
        return updated
      }

      async function ensureSearxngSettingsFile(): Promise<{ ok: boolean; error?: string }> {
        mkdirSync(SETTINGS_DIR, { recursive: true })
        if (existsSync(SETTINGS_FILE)) {
          const current = readFileSync(SETTINGS_FILE, "utf8")
          const updated = withManagedSearxngSettings(current)
          if (updated !== current) writeFileSync(SETTINGS_FILE, updated, "utf8")
          if (/^\s*-\s*json\s*$/m.test(updated) && /^\s*safe_search:\s*0\s*$/m.test(updated)) return { ok: true }
        }

        const bootstrapContainer = `${CONTAINER_NAME}-bootstrap`
        let createdBootstrap = false
        try {
          const containers = await findAllSearxngContainers()
          const ours = containers.find(container => container.isOurs)
          if (ours) {
            await execFileAsync("docker", ["cp", `${CONTAINER_NAME}:/etc/searxng/settings.yml`, SETTINGS_FILE], { timeout: 15_000 })
          } else {
            await execFileAsync("docker", ["run", "-d", "--name", bootstrapContainer, "searxng/searxng:latest"], { timeout: 60_000 })
            createdBootstrap = true
            await new Promise(resolve => setTimeout(resolve, 3000))
            await execFileAsync("docker", ["cp", `${bootstrapContainer}:/etc/searxng/settings.yml`, SETTINGS_FILE], { timeout: 15_000 })
          }
          const updated = withManagedSearxngSettings(readFileSync(SETTINGS_FILE, "utf8"))
          writeFileSync(SETTINGS_FILE, updated, "utf8")
          return { ok: true }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { ok: false, error: `Failed to prepare SearxNG settings: ${message}` }
        } finally {
          if (createdBootstrap) {
            await execFileAsync("docker", ["rm", "-f", bootstrapContainer], { timeout: 15_000 }).catch(() => {})
          }
        }
      }

      async function probeJsonApi() {
        try {
          const response = await fetch(`${SEARXNG_URL}/search?q=mountains&categories=images&format=json`, {
            signal: AbortSignal.timeout(5000),
          })
          return response.ok
        } catch {
          return false
        }
      }

      // 1. Check if SearxNG is reachable
      let alive = false
      try {
        const probe = await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(3000) })
        alive = probe.ok && await probeJsonApi()
      } catch {}

      // 2. If not alive, ensure Docker container is running
      if (!alive) {
        try {
          const settings = await ensureSearxngSettingsFile()
          if (!settings.ok) {
            return { ok: false, error: settings.error ?? "Failed to prepare SearxNG settings." }
          }

          const containers = await findAllSearxngContainers()
          const ours = containers.find(container => container.isOurs)

          for (const container of containers.filter(container => !container.isOurs)) {
            await execFileAsync("docker", ["rm", "-f", container.id], { timeout: 15_000 })
          }

          if (ours) {
            await execFileAsync("docker", ["rm", "-f", CONTAINER_NAME], { timeout: 15_000 }).catch(() => {})
          }
          await execFileAsync("docker", [
            "run", "-d",
            "--name", CONTAINER_NAME,
            "-p", `127.0.0.1:${SEARXNG_PORT}:8080`,
            "--restart", "unless-stopped",
            "-v", `${SETTINGS_FILE}:/etc/searxng/settings.yml:ro`,
            "searxng/searxng:latest",
          ], { timeout: 60_000 })
        } catch (dockerErr) {
          const msg = dockerErr instanceof Error ? dockerErr.message : String(dockerErr)
          return { ok: false, error: `Failed to start SearxNG container: ${msg}` }
        }

        alive = await waitForHealthy(25) && await probeJsonApi()
        if (!alive) {
          return { ok: false, error: "SearxNG container started but its JSON API did not become ready within 25s." }
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

  // ---------------------------------------------------------------------------
  // Master Configuration Hub
  // ---------------------------------------------------------------------------
  {
    name: "tool_manage_config",
    description: "Read or update technical configuration stored in SQLite CONF_* wings. Use this instead of reading or writing JSON config files manually.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write"] },
        wing: { type: "string", enum: [...CONFIG_WING_ORDER] },
        value: {},
      },
      required: ["action", "wing"],
      additionalProperties: false,
    },
    concurrencySafe: false,
    async run(input, context) {
      const action = requireString(input, "action") as "read" | "write"
      const wing = requireString(input, "wing") as ConfigWingName
      if (action === "read") {
        return { wing, value: readConfigWing(context.rootDir, wing) }
      }
      const value = input.value
      if (value === undefined) throw new Error("value is required when action='write'")
      const normalizedValue = normalizeConfigWingValue(wing, value)
      const result = writeConfigWing(context.rootDir, wing, normalizedValue as never)
      if (wing === "CONF_SYSTEM" || wing === "CONF_MODELS") {
        loadAndApplyModelSettings(process.env)
      }
      appendActionLog(context.rootDir, "Configuracion tecnica modificada", {
        wing,
        changed: result.changed,
      })
      return {
        wing,
        ok: true,
        changed: result.changed,
        bytes: result.bytes,
        effect: wing === "CONF_SYSTEM" || wing === "CONF_MODELS"
          ? "model_config_reloaded"
          : wing === "CONF_WEBSEARCH"
            ? "websearch_config_applied"
            : "stored",
      }
    },
  },
  {
    name: "show_master_dashboard",
    aliases: ["master_config", "config_hub"],
    description:
      "Opens the Master Configuration Hub — an interactive menu for managing all system settings: models, channels, web search, audio/voice, and system configuration. ALWAYS use this tool (instead of reading config files manually) when the user wants to view or change settings, configure the system, or asks about current configuration. The tool returns a visual interactive menu to the CLI.",
    inputSchema: emptyInputSchema,
    concurrencySafe: true,
    async run() {
      const { buildMasterDashboard } = await import("../menu/masterDashboard.ts")
      return buildMasterDashboard()
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
