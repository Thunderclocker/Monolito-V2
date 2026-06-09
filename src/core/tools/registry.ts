// Public tool registry barrel.
//
// This file is the single public entry point for the tool system. It re-exports
// the shared types/helpers from ./internal.ts and combines the per-domain tool
// arrays from ./domains/*.ts into the master `tools` list consumed by the
// runtime, the TUI, and the prompt-caching layer.
//
// To add a new tool:
//   1. Add it to the appropriate domain file under ./domains/
//   2. If it lives in a brand-new domain, add the import + concat below
//   3. Update the appropriate docs file in /docs/

import { upsertRalphRule, listDynamicSkills, saveDynamicSkill, getDynamicSkill, upsertSemanticTool, querySemanticTools } from "../session/store.ts"

import { withSafeToolFailure } from "./internal.ts"
import { type Logger, createLogger } from "../logging/logger.ts"

// ─── Domain tool arrays ─────────────────────────────────────────────────────
import { shellTools } from "./domains/shell.ts"
import { mcpTools } from "./domains/mcp.ts"
import { webTools } from "./domains/web.ts"
import { fileTools } from "./domains/file.ts"
import { gitTools } from "./domains/git.ts"
import { telegramTools } from "./domains/telegram.ts"
import { mediaTools } from "./domains/media.ts"
import { memoryTools } from "./domains/memory.ts"
import { forensicsTools } from "./domains/forensics.ts"
import { delegationTools } from "./domains/delegation.ts"
import { configTools } from "./domains/config.ts"
import { todoTools } from "./domains/todo.ts"
import { adminTools } from "./domains/admin.ts"
import { skillsTools } from "./domains/skills.ts"

import type { ToolDefinition } from "./internal.ts"

// ─── Re-exports for the public API ──────────────────────────────────────────
export { formatToolError, resolveWorkspacePath } from "./internal.ts"
export type { ToolContext, ToolInputSchema, ToolDefinition } from "./internal.ts"

const rawTools: ToolDefinition[] = [
  ...shellTools,
  ...fileTools,
  ...gitTools,
  ...mcpTools,
  ...webTools,
  ...telegramTools,
  ...mediaTools,
  ...memoryTools,
  ...forensicsTools,
  ...delegationTools,
  ...configTools,
  ...todoTools,
  ...adminTools,
  ...skillsTools,
]

const tools: ToolDefinition[] = rawTools.map(withSafeToolFailure)

const logger = createLogger("tools")

export function listTools() {
  return tools
}

export function listModelTools(isSubAgent = false, lastUserText?: string | boolean | string[], allowedToolNames?: string[], rootDir?: string, exposeTelegramDownload = false) {
  // Service-management and infra tools: ALWAYS hidden from sub-agents
  // (these deploy/manage daemons, change config, spawn new agents, etc.).
  const hiddenFromSubAgents = new Set([
    "AgentSpawn",
    "AgentSendMessage",
    "AgentStop",
    "delegate_background_task",
    "list_active_workers",
    "TelegramSend",
    "TelegramSendAudio",
    "TelegramSendVoice",
    "TelegramSendPhoto",
    "TelegramSendDocument",
    "schedule_task",
    "system_reboot",
    "system_status",
    "QueryCost",
    "QuerySessionStats",
    "CompactSession",
    "SttServiceStatus",
    "SttServiceDeploy",
    "SttServiceStop",
    "SttServiceRemove",
    "SttServiceList",
    "tool_manage_config",
    "ProfileCreate",
    "AgentList",
    "TelegramDownloadFile"
  ])

  // Note: User-facing media operations (VoiceClone, GenerateSpeech,
  // TranscribeAudio) are intentionally NOT hidden from sub-agents. The
  // previous blanket hide forced workers to call them via McpInvokeTool
  // (which returns "Unknown MCP server: tts") instead of directly,
  // causing the cloning tool to silently fail and the agent to
  // hallucinate success. The infra/service-management tools above stay
  // hidden so sub-agents can't spin up daemons or reconfigure channels.

  const hiddenFromMainSession = new Set([
    "TelegramDownloadFile",
    // File-editing tools (Edit/Write/MultiEdit) are hidden from the main
    // orchestrator session to prevent the model from attempting in-place
    // edits from the user-facing chat. The orchestrator should delegate
    // file modifications to a sub-agent via delegate_background_task, which
    // has the proper scope and error-recovery path. Including these in the
    // main session caused silent Edit failures (e.g. tool "Edit" returned
    // status="error" without a clear reason) and triggered tdd-react
    // recovery loops that surfaced as 800-word confabulation essays.
    "Edit",
    "Write",
    "MultiEdit",
  ])

  if (exposeTelegramDownload) {
    hiddenFromSubAgents.delete("TelegramDownloadFile")
    hiddenFromMainSession.delete("TelegramDownloadFile")
  }

  // Narrow the main-session tool lockdown: previously any user message
  // that contained an image word (imagen/foto/vision/visual) caused
  // Bash/Write/Edit/MultiEdit/TodoWrite to be dropped, which forced
  // every image task through delegate_background_task even for trivial
  // "mandame una foto de X". Now we only apply that lockdown when the
  // user text also carries an edit-verb (modifica/cambia/edita/escribe/
  // crea), which is the actual dangerous case.
  const isImageWithEditIntent = (text: string) =>
    /(imagen(?:es)?|foto(?:s)?|picture(?:s)?|photo(?:s)?|image(?:s)?)\b/i.test(text) &&
    /(modific|cambi|edit|escrib|crea|reescrib|reemplaz|borra|elimin)/i.test(text)

  const blockedTools = Array.isArray(lastUserText)
    ? lastUserText
    : typeof lastUserText === "boolean"
      ? (lastUserText ? ["AgentList", "ProfileCreate", "Write", "Edit", "MultiEdit", "Bash", "TodoWrite"] : [])
      : (typeof lastUserText === "string" && lastUserText === "true")
        ? ["AgentList", "ProfileCreate", "Write", "Edit", "MultiEdit", "Bash", "TodoWrite"]
        : (typeof lastUserText === "string" && isImageWithEditIntent(lastUserText))
          ? ["AgentList", "ProfileCreate", "Write", "Edit", "MultiEdit", "Bash", "TodoWrite"]
          : []

  const CORE_TOOLS = new Set([
    "TodoWrite",
    "TodoList",
    "delegate_background_task",
    "search_tools",
    "Bash",
    // Edit/Write/MultiEdit removed from CORE_TOOLS: now hidden from main session,
    // available only to sub-agents via their own scope. See hiddenFromMainSession
    // for the rationale.
    "AgentSendMessage",
    "AgentSpawn",
    "AgentStop",
    "TelegramSend",
    "TelegramSendPhoto",
    "ImageSearch",
    "DownloadFile",
    "GenerateImage",
    "VisionAnalyze",
    "TelegramGetRecentPhotos",
  ])

  const staticMapped = tools
    .filter(tool => {
      // 1. Core Tools are ALWAYS included
      if (CORE_TOOLS.has(tool.name)) {
        if (isSubAgent && hiddenFromSubAgents.has(tool.name)) return false;
        if (isSubAgent && blockedTools.includes(tool.name)) return false;
        if (!isSubAgent && hiddenFromMainSession.has(tool.name)) return false;
        return true;
      }
      // 2. Hidden-from-sub-agents tools are NEVER included for sub-agents
      if (isSubAgent && hiddenFromSubAgents.has(tool.name)) return false;
      // 3. Hidden-from-main-session tools are NEVER included for main
      if (!isSubAgent && hiddenFromMainSession.has(tool.name)) return false;
      // 4. allowedToolNames whitelist (per session) takes precedence over lastUserText
      if (Array.isArray(allowedToolNames) && allowedToolNames.length > 0) {
        return allowedToolNames.includes(tool.name)
      }
      // 5. If a lastUserText was passed, decide via "delegation" vs "execution" mode
      if (lastUserText !== undefined) {
        // For sub-agents: if lastUserText matches delegation cues, only return delegation tools
        if (isSubAgent) {
          if (blockedTools.includes(tool.name)) return false
          // Otherwise: when isSubAgent, return all non-hidden tools
          return true
        }
        // For main session: use lastUserText to decide if we should filter to a core subset
        if (blockedTools.includes(tool.name)) return false
        return true
      }
      // 6. Default: include all non-hidden tools
      return true
    })
    .filter(tool => !isSubAgent || allowedToolNames === undefined || allowedToolNames.length === 0 || allowedToolNames.includes(tool.name))

  // Note: the above filter may include sub-agent tools that should NOT be
  // visible to a sub-agent when allowedToolNames is undefined. We add a final
  // pass to ensure hidden-from-sub-agents tools are excluded.
  return staticMapped.filter(tool => {
    if (isSubAgent && hiddenFromSubAgents.has(tool.name)) return false
    if (!isSubAgent && hiddenFromMainSession.has(tool.name)) return false
    return true
  })
}

export function getTool(name: string) {
  return tools.find(tool => tool.name === name || tool.aliases?.includes(name))
}

export function validateToolInput(name: string, input: Record<string, unknown>) {
  const tool = getTool(name)
  if (!tool) return `Unknown tool: ${name}`
  if (!tool.validate) return null
  return tool.validate(input)
}

export function isToolConcurrencySafe(name: string, input: Record<string, unknown>) {
  const tool = getTool(name)
  if (!tool) return false
  if (typeof tool.concurrencySafe === "function") return tool.concurrencySafe(input)
  return tool.concurrencySafe === true
}

export function isToolSideEffect(name: string): boolean {
  const tool = getTool(name)
  return tool?.sideEffect === true
}

export async function indexToolsInPalace(rootDir: string) {
  const summaries: Array<{ name: string; description: string; tier: string; tags: string[] }> = []
  for (const tool of tools) {
    summaries.push({
      name: tool.name,
      description: tool.description,
      tier: tool.permissionTier,
      tags: [tool.permissionTier, "tool"],
    })
  }
  try {
    for (const summary of summaries) {
      try {
        await upsertSemanticTool(rootDir, summary.name, JSON.stringify({
          description: summary.description,
          tier: summary.tier,
          tags: summary.tags,
        }))
      } catch (err) {
        logger.error("Failed to index tool", { toolName: summary.name, errorMessage: String(err), errorStack: err instanceof Error ? err.stack : undefined })
      }
    }
  } catch (err) {
    logger.error("Failed to index tools", { errorMessage: String(err), errorStack: err instanceof Error ? err.stack : undefined })
  }

  // Index dynamic skills too
  try {
    const skills = listDynamicSkills(rootDir)
    for (const skill of skills) {
      try {
        // Index the skill as a synthetic tool summary for search
        const existing = await querySemanticTools(rootDir, skill.name, 1)
        if (existing.length > 0 && existing[0] === skill.name) {
          // Skip if already there (avoid duplicate indexes)
          continue
        }
        upsertSemanticTool(rootDir, skill.name, JSON.stringify({
          description: skill.description ?? "(no description)",
          tier: "read",
          tags: ["skill", "dynamic"],
        }))
      } catch (err) {
        console.error(`[indexToolsInPalace] Failed to upsert skill '${skill.name}':`, err)
      }
    }
  } catch (err) {
    logger.error("Failed to index dynamic skills:", { errorMessage: String(err), errorStack: (err instanceof Error ? err.stack : undefined) })
  }
}

export async function indexRalphRulesInPalace(rootDir: string) {
  // The previous "image_verification" rule has been removed.
  //
  // Rationale: it forced VisionAnalyze on every image task that matched
  // the verification regex, but the regex fired on bare words like
  // "vision" / "visual" which produced false positives ("tengo
  // problemas de vision", "buena visual"). The user has expressed
  // a preference for soft guidance: the LLM should decide based on
  // context, with no hard rule forcing the tool. The new
  // consolidated guidance lives in BOOT_TOOLS and in the main
  // system prompt's "Visual & Media Processing Protocol" section.
  //
  // Any pre-existing rows in palace_nodes are left in place but
  // become inert — they are no longer re-indexed here, and the
  // checkDynamicRalphRules flow will simply not find a rule with
  // name "image_verification" unless something else adds it back.

  // The enumerate_dynamic_state rule is enforced semantically via the
  // EVIDENCE-FIRST RULE in the orchestrator system prompt. The orchestrator's
  // checkDynamicRalphRules uses a hard requiredTools list to decide if the
  // rule applies, but this rule covers many resources (skills, files,
  // channels, processes, configs, profiles, models) — each one maps to a
  // different tool. A hardcoded requiredTools list would either be
  // too narrow (blocking legitimate tool calls) or too broad (never firing).
  // We keep the rule definition as documentation but skip the tool-list
  // enforcement by passing an empty requiredTools array, which makes the
  // orchestrator skip the check (see orchestrator.ts checkDynamicRalphRules).
  const enumerateDynamicStateRule = {
    name: "Enumerate Dynamic State Rule",
    description: "Checks if the user is asking to enumerate, list, show, count, or inventory the current state of a dynamic system resource (skills, sessions, files, channels, tools, processes, configs). When the user asks for a live enumeration, the answer must come from a tool, not from memory.",
    intentRegex: "\\b(listame|lista|listas|listar|enumera|enumerar|mostrame|mostrar|ensename|ensenar|dime\\s+(?:que|cuales|cuantas|cuantos|qué|cuáles|cuántas|cuántos)|inventario|inventaria|qué\\s+(?:skills|herramientas|sessions|sesiones|archivos|files|tools|tienes|hay|existen)|how\\s+many|cuantas?\\s+(?:skills|herramientas|sessions|sesiones|archivos|files|tools|hay)|show\\s+(?:me\\s+)?(?:all\\s+)?(?:your\\s+)?(?:skills|sessions|files|tools))\\b",
    requiredRegex: "\\b(skills?|herramientas?|tools?|sessions?|sesiones?|archivos?|files?|canales?|channels?|procesos?|processes?|configs?|profiles?|modelos?|models?)\\b",
    requiredTools: [],
    errorMessage: "[Ralph Loop] SYSTEM ALERT\nEl usuario pidió enumerar/listar el estado actual de un recurso dinámico del sistema (skills, sessions, archivos, tools, etc.).\nTu respuesta parece basada en memoria/recuerdo, NO en una tool ejecutada en este turno.\nEsto está PROHIBIDO. La respuesta correcta es ejecutar la tool correspondiente (ListSkills para skills, Read/Glob/list_files para archivos, etc.) y reportar lo que la tool devuelve.\nNO respondas desde memoria con disclaimers ('tomátelo con pinzas', 'no verifiqué', 'si querés el 100% decime').\nCorregilo: ejecutá la tool apropiada y respondé con el resultado real."
  }

  try {
    upsertRalphRule(rootDir, "enumerate_dynamic_state", JSON.stringify(enumerateDynamicStateRule, null, 2))
  } catch (err) {
    logger.error("[indexRalphRulesInPalace] Failed to index enumerate_dynamic_state rule:", { errorMessage: String(err), errorStack: (err instanceof Error ? err.stack : undefined) })
  }
}
