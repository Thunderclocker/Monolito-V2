import { type MenuState, type MenuStep } from "./types.ts"
import { readChannelsConfig, writeChannelsConfig, type ChannelsConfig } from "../../../core/channels/config.ts"

export type MenuResult = {
  output: string
  nextState: MenuState
  tone: "neutral" | "info" | "success" | "error"
  refreshHeader?: boolean
  restartDaemon?: boolean
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderMenuOptions(config: ChannelsConfig): string {
  const tel = config.telegram
  const status = tel?.enabled ? "On ✅" : "Off ❌"
  const tokenSetup = tel?.token ? "Configured 🔑" : "Token missing 🛑"
  const chatsLimit = tel?.allowedChats?.length ? `${tel.allowedChats.length} authorized chats` : "Open to public ⚠️"

  return [
    `Channel Configuration`,
    `---------------------`,
    `Channel: Telegram (status: ${status})`,
    `  Token:  ${tokenSetup}`,
    `  Access: ${chatsLimit}`,
    ``,
    `Options:`,
    `1. ${tel?.enabled ? "Turn off" : "Turn on"} Telegram integration`,
    `2. Configure Telegram Bot Token`,
    `3. Configure Authorized Chats`,
    `0. Exit`,
    ``,
    `Enter option number:`,
  ].join("\n")
}

export function openChannelMenu(prefixMessage?: string, tone: MenuResult["tone"] = "info", refreshHeader?: boolean): MenuResult {
  const config = readChannelsConfig()
  const menu = renderMenuOptions(config)
  return {
    output: prefixMessage ? `${prefixMessage}\n\n${menu}` : menu,
    nextState: { step: "chan-main", draft: {} },
    tone: tone,
    refreshHeader: refreshHeader,
  }
}

function exitMenu(message: string): MenuResult {
  return { output: message, nextState: null, tone: "info" }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function processChannelMenuInput(input: string, state: MenuState): Promise<MenuResult> {
  if (!state) return exitMenu("Menu closed.")
  const trimmed = input.trim()

  if (["salir", "exit", "q", "/channels"].includes(trimmed.toLowerCase())) {
    return exitMenu("Menu closed.")
  }

  if (trimmed === "0" && state.step === "chan-main") {
    return exitMenu("Menu closed.")
  }

  switch (state.step) {
    case "chan-main":
      return handleMainMenu(trimmed)
    case "chan-tel-token":
      return handleTelToken(trimmed)
    case "chan-tel-chats":
      return handleTelChats(trimmed)
    default:
      return exitMenu("Unknown state. Menu closed.")
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleMainMenu(input: string): MenuResult {
  const config = readChannelsConfig()
  
  if (input === "1") {
    // Toggle telegram
    if (!config.telegram) {
      config.telegram = { token: "", enabled: true, allowedChats: [] }
    } else {
      config.telegram.enabled = !config.telegram.enabled
    }
    writeChannelsConfig(config)
    const tel = config.telegram
    return {
      ...openChannelMenu(`Telegram integration has been ${tel.enabled ? 'turned on' : 'turned off'}.`, "success", true),
      restartDaemon: true,
    }
  }
  
  if (input === "2") {
    return {
      output: `📝 Enter Telegram Bot Token (e.g. 123456789:ABCDEF...):\n(Or type 'cancel' to go back)`,
      nextState: { step: "chan-tel-token", draft: {} },
      tone: "info"
    }
  }

  if (input === "3") {
    const currentChats = config.telegram?.allowedChats ?? []
    const chatsList = currentChats.length > 0 ? currentChats.join(", ") : "(none — open to all)"
    return {
      output: [
        `📋 Current authorized chats: ${chatsList}`,
        ``,
        `Enter Chat IDs separated by comma (e.g. 1515784684, -100123456).`,
        `Type 'clear' to allow all chats.`,
        `Type 'cancel' to go back.`,
      ].join("\n"),
      nextState: { step: "chan-tel-chats", draft: {} },
      tone: "info"
    }
  }

  return openChannelMenu("❌ Invalid option.", "error")
}

function handleTelToken(input: string): MenuResult {
  if (input.toLowerCase() === "cancel" || input.toLowerCase() === "cancelar") {
    return openChannelMenu("Operation cancelled.", "info")
  }

  const token = input.trim()
  if (!token) return openChannelMenu("❌ Empty token.", "error")

  const config = readChannelsConfig()
  if (!config.telegram) {
    config.telegram = { token, enabled: true, allowedChats: [] }
  } else {
    config.telegram.token = token
  }
  writeChannelsConfig(config)

  return {
    ...openChannelMenu("Token saved successfully.", "success"),
    restartDaemon: true,
  }
}

function handleTelChats(input: string): MenuResult {
  if (input.toLowerCase() === "cancel" || input.toLowerCase() === "cancelar") {
    return openChannelMenu("Operation cancelled.", "info")
  }

  const config = readChannelsConfig()
  if (!config.telegram) {
    config.telegram = { token: "", enabled: false, allowedChats: [] }
  }

  if (input.toLowerCase() === "clear" || input.toLowerCase() === "limpiar") {
    config.telegram.allowedChats = []
    writeChannelsConfig(config)
    return {
      ...openChannelMenu("Authorized chats cleared. Any chat can send messages.", "success"),
      restartDaemon: true,
    }
  }

  const ids = input.split(",").map(s => s.trim()).filter(Boolean).map(Number)
  const invalid = ids.filter(n => !Number.isFinite(n) || n === 0)
  if (invalid.length > 0) {
    return openChannelMenu(`❌ Invalid IDs: ${invalid.join(", ")}. Must be integers.`, "error")
  }

  config.telegram.allowedChats = ids
  writeChannelsConfig(config)
  return {
    ...openChannelMenu(`✅ ${ids.length} authorized chat(s): ${ids.join(", ")}.`, "success"),
    restartDaemon: true,
  }
}
