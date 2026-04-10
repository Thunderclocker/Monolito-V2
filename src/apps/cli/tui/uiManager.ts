/**
 * UIManager — coordinates the Master Dashboard and delegates to existing sub-menu state machines.
 *
 * When the user enters the master dashboard (via tool or /dashboard),
 * this module tracks which sub-domain is active and routes input accordingly.
 * When a sub-menu closes, it rebuilds the dashboard with fresh config data.
 */
import type { MenuState } from "./types.ts"
import type { MenuDefinition, MenuDomain, MenuSchemaEnvelope } from "../../../core/menu/schema.ts"
import { buildMasterDashboard } from "../../../core/menu/masterDashboard.ts"
import { openModelMenu, processMenuInput } from "./modelMenu.ts"
import { openChannelMenu, processChannelMenuInput } from "./channelMenu.ts"
import { openWebSearchMenu, processWebSearchMenuInput } from "./websearchMenu.ts"

/** Unified result returned by UIManager for every interaction */
export type UIMenuResult = {
  output: string
  tone: "neutral" | "info" | "success" | "error"
  finished: boolean
  refreshHeader?: boolean
  restartDaemon?: boolean
}

/**
 * Tracks the state of the master dashboard and any active sub-menu.
 * Stored on ComposerState as a single field.
 */
export type MasterMenuState = {
  /** Currently active sub-domain, or null if at top-level dashboard */
  activeDomain: MenuDomain | null
  /** The current dashboard schema (for re-rendering on invalid input) */
  dashboardSchema: MenuDefinition
  /** State for delegated sub-menus */
  modelState: MenuState
  channelState: MenuState
  websearchState: MenuState
} | null

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render a MenuDefinition to plain text for the transcript */
export function renderMenuDefinition(menu: MenuDefinition): string {
  const lines: string[] = []
  lines.push(menu.title)
  lines.push("-".repeat(menu.title.length))
  if (menu.subtitle) lines.push(menu.subtitle)
  lines.push("")
  lines.push("Opciones:")
  for (const opt of menu.options) {
    lines.push(`  ${opt.key}. ${opt.label}`)
  }
  lines.push("")
  lines.push("Ingresa el numero:")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Open / Initialize
// ---------------------------------------------------------------------------

/** Initialize the master dashboard from a MenuSchemaEnvelope (synchronous) */
export function openMasterDashboard(envelope: MenuSchemaEnvelope): { result: UIMenuResult; state: MasterMenuState } {
  const text = envelope.menu.prefixMessage
    ? `${envelope.menu.prefixMessage}\n\n${renderMenuDefinition(envelope.menu)}`
    : renderMenuDefinition(envelope.menu)
  return {
    result: { output: text, tone: envelope.menu.tone, finished: false },
    state: {
      activeDomain: null,
      dashboardSchema: envelope.menu,
      modelState: null,
      channelState: null,
      websearchState: null,
    },
  }
}

// ---------------------------------------------------------------------------
// Input processing
// ---------------------------------------------------------------------------

/** Process user input against the current master menu state */
export async function processMasterMenuInput(
  input: string,
  state: MasterMenuState,
): Promise<{ result: UIMenuResult; state: MasterMenuState }> {
  if (!state) {
    return {
      result: { output: "Menu cerrado.", tone: "neutral", finished: true },
      state: null,
    }
  }

  const trimmed = input.trim()
  const normalized = trimmed.toLowerCase()

  // Global exit commands (only at dashboard level)
  if (!state.activeDomain && ["salir", "exit", "q"].includes(normalized)) {
    return {
      result: { output: "Panel de configuracion cerrado.", tone: "neutral", finished: true },
      state: null,
    }
  }

  // If a sub-domain is active, route input there
  if (state.activeDomain) {
    return await processSubDomainInput(trimmed, state)
  }

  // Top-level dashboard: match by key
  const option = state.dashboardSchema.options.find(o => o.key === trimmed)
  if (!option) {
    const menu = renderMenuDefinition(state.dashboardSchema)
    return {
      result: { output: `Opcion "${trimmed}" no valida.\n\n${menu}`, tone: "error", finished: false },
      state,
    }
  }

  if (option.action.type === "exit") {
    return {
      result: { output: "Panel de configuracion cerrado.", tone: "neutral", finished: true },
      state: null,
    }
  }

  if (option.action.type === "delegate") {
    return await enterSubDomain(option.action.menuDomain, state)
  }

  return {
    result: { output: "Accion no implementada.", tone: "error", finished: false },
    state,
  }
}

// ---------------------------------------------------------------------------
// Sub-domain entry
// ---------------------------------------------------------------------------

async function enterSubDomain(
  domain: MenuDomain,
  state: MasterMenuState,
): Promise<{ result: UIMenuResult; state: MasterMenuState }> {
  switch (domain) {
    case "model": {
      const r = openModelMenu()
      return {
        result: { output: r.output, tone: r.tone, finished: false, refreshHeader: r.refreshHeader },
        state: { ...state!, activeDomain: "model", modelState: r.nextState },
      }
    }
    case "channels": {
      const r = openChannelMenu()
      return {
        result: { output: r.output, tone: r.tone, finished: false, refreshHeader: r.refreshHeader },
        state: { ...state!, activeDomain: "channels", channelState: r.nextState },
      }
    }
    case "websearch": {
      const r = await openWebSearchMenu()
      return {
        result: { output: r.output, tone: r.tone, finished: false },
        state: { ...state!, activeDomain: "websearch", websearchState: r.nextState },
      }
    }
    case "audio": {
      const envelope = buildMasterDashboard("Audio y Voz: Proximamente. Usa /tts y /stt por ahora.")
      const dash = renderMenuDefinition(envelope.menu)
      return {
        result: { output: `Audio y Voz: Proximamente. Usa /tts y /stt por ahora.\n\n${dash}`, tone: "info", finished: false },
        state: { ...state!, activeDomain: null, dashboardSchema: envelope.menu },
      }
    }
    case "system": {
      const envelope = buildMasterDashboard("Sistema: Proximamente.")
      const dash = renderMenuDefinition(envelope.menu)
      return {
        result: { output: `Sistema: Proximamente.\n\n${dash}`, tone: "info", finished: false },
        state: { ...state!, activeDomain: null, dashboardSchema: envelope.menu },
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-domain input routing
// ---------------------------------------------------------------------------

async function processSubDomainInput(
  input: string,
  state: MasterMenuState,
): Promise<{ result: UIMenuResult; state: MasterMenuState }> {
  if (!state?.activeDomain) {
    return { result: { output: "Error interno.", tone: "error", finished: false }, state: state! }
  }

  switch (state.activeDomain) {
    case "model": {
      const r = await processMenuInput(input, state.modelState)
      if (r.nextState === null) {
        return returnToDashboard(r.output, r.refreshHeader)
      }
      return {
        result: { output: r.output, tone: r.tone, finished: false, refreshHeader: r.refreshHeader },
        state: { ...state!, modelState: r.nextState },
      }
    }
    case "channels": {
      const r = await processChannelMenuInput(input, state.channelState)
      if (r.nextState === null) {
        return returnToDashboard(r.output, r.refreshHeader, r.restartDaemon)
      }
      return {
        result: { output: r.output, tone: r.tone, finished: false, refreshHeader: r.refreshHeader, restartDaemon: r.restartDaemon },
        state: { ...state!, channelState: r.nextState },
      }
    }
    case "websearch": {
      const r = await processWebSearchMenuInput(input, state.websearchState)
      if (r.nextState === null) {
        return returnToDashboard(r.output)
      }
      return {
        result: { output: r.output, tone: r.tone, finished: false },
        state: { ...state!, websearchState: r.nextState },
      }
    }
    default:
      return returnToDashboard()
  }
}

// ---------------------------------------------------------------------------
// Return to dashboard
// ---------------------------------------------------------------------------

function returnToDashboard(
  prefixMessage?: string,
  refreshHeader?: boolean,
  restartDaemon?: boolean,
): { result: UIMenuResult; state: MasterMenuState } {
  const envelope = buildMasterDashboard(prefixMessage)
  const text = renderMenuDefinition(envelope.menu)
  const output = prefixMessage ? `${prefixMessage}\n\n${text}` : text

  return {
    result: { output, tone: "info", finished: false, refreshHeader, restartDaemon },
    state: {
      activeDomain: null,
      dashboardSchema: envelope.menu,
      modelState: null,
      channelState: null,
      websearchState: null,
    },
  }
}
