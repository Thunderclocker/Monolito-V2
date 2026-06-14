import type { MasterMenuState } from "./uiManager.ts"

export type CompletionMatch = [string[], string]

export type CliSessionError = Error & {
  code?: string
}

export type MenuStep =
  | "main"           // Main menu: list/add/edit/delete/select/discover
  | "select"         // Picking a profile to activate
  | "add-provider"   // Step 1: choose provider
  | "add-baseurl"    // Step 2: set base URL
  | "add-apikey"     // Step 3: set API key
  | "add-model-pick" // Step 4: choose a discovered model or switch to manual input
  | "add-model"      // Step 5: set model name manually
  | "add-name"       // Step 6: set friendly name
  | "edit-pick"      // Pick profile to edit
  | "edit-field"     // Pick field to edit
  | "edit-value"     // Enter new value for field
  | "delete-pick"    // Pick profile to delete
  | "delete-confirm" // Confirm deletion
  | "xai-oauth-pick" // xAI Grok OAuth mode picker (CLI command proxy)
  | "xai-oauth-code" // xAI Grok OAuth code pasting step
  // Channel menu steps
  | "chan-main"      // Channel main menu
  | "chan-tel-token" // Set Telegram bot token
  | "chan-tel-chats" // Set allowed chat IDs
  // Web search menu steps (SearXNG submenu removed; only the provider
  // picker remains)
  | "ws-main"        // Web search main menu

export type MenuState = {
  step: MenuStep
  /** Accumulated data for add/edit wizards */
  draft: {
    provider?: string
    baseUrl?: string
    apiKey?: string
    model?: string
    name?: string
  }
  /** Profile ID being edited/deleted */
  targetId?: string
  /** Field being edited */
  editField?: string
  /** Discovered models available for selection */
  availableModels?: string[]
} | null

export type ComposerState = {
  input: string
  cursor: number
  busy: boolean
  thinkingFrame: number
  thinkingVisible: boolean
  suggestions: string[]
  toolThinkingFrame: number
  toolThinkingText: string
  menuState: MenuState
  channelMenuState: MenuState
  websearchMenuState: MenuState
  masterMenuState: MasterMenuState
  masterMenuEphemeral: boolean
  permissionPrompt: {
    permissionId: string
    tool: string
    path: string
    reason: string
  } | null
  accumulatedThinking?: string
  showThinkingContent: boolean
}

export type HeaderState = {
  projectName: string
  version: string
  workspacePath: string
  model: string
  provider: string
  reasoning: string
  sessionId: string
  connected: boolean
  minimaxBalance: string | null
}

export type PromptHistory = {
  items: string[]
  index: number
  draft: string
}

export type TranscriptBlock =
  | { type: "message"; role: "user" | "assistant"; text: string }
  | { type: "assistant-meta"; text: string }
  | { type: "event"; label: string; tone: "neutral" | "info" | "success" | "error"; text: string; tool?: string; replacesLastEvent?: boolean; toolUseId?: string; isMemoryAgent?: boolean }
  | { type: "todo-list"; completed: number; total: number; items: { status: "pending" | "in_progress" | "completed"; content: string; activeForm?: string }[] }

export type TranscriptViewport = {
  blocks: TranscriptBlock[]
  scrollOffset: number
}

export type MouseAction = "scrollUp" | "scrollDown"
export type ScreenMode = "interactive" | "copy"
