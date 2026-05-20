/**
 * Interactive model menu state machine.
 *
 * When the user types `/model`, the session enters "menu mode".
 * Input is intercepted and routed here instead of the daemon.
 * Each step renders a menu block in the transcript and waits for input.
 */
import {
  type ModelProfile,
  type ModelProvider,
  type ModelProfileDraft,
  listProfiles,
  getActiveProfile,
  addProfile,
  updateProfile,
  deleteProfile,
  activateProfileByIndex,
  getProfileByIndex,
  getProviderDefaults,
  getAvailableProviders,
  discoverOllamaModels,
  discoverProviderModels,
  addOllamaDiscoveredModels,
  redactProfile,
} from "../../../core/runtime/modelRegistry.ts"
import { applyProfileToEnv, readModelSettings } from "../../../core/runtime/modelConfig.ts"
import type { MenuState, MenuStep } from "./types.ts"

export type MenuResult = {
  /** Text to show in transcript as an event block */
  output: string
  /** Next menu state (null = exit menu) */
  nextState: MenuState
  /** Tone for the event block */
  tone: "neutral" | "info" | "success" | "error"
  /** If true, refresh the header after this action */
  refreshHeader?: boolean
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function profileLine(profile: ModelProfile, index: number, isActive: boolean): string {
  const marker = isActive ? " (active)" : ""
  const redacted = redactProfile(profile)
  return `${index + 1}. ${redacted.name}  (${redacted.provider})  model: ${redacted.model}${marker}`
}

function renderProfileList(): string {
  const profiles = listProfiles()
  const active = getActiveProfile()
  if (profiles.length === 0) {
    return "No profiles configured."
  }
  const lines = profiles.map((p, i) => profileLine(p, i, p.id === active?.id))
  return lines.join("\n")
}

function renderProfileDetail(profile: ModelProfile): string {
  const redacted = redactProfile(profile)
  return [
    `  Name:      ${redacted.name}`,
    `  Provider:  ${redacted.provider}`,
    `  Base URL:  ${redacted.baseUrl || "(default)"}`,
    `  API Key:   ${redacted.apiKey}`,
    `  Model:     ${redacted.model}`,
    `  Active:    ${redacted.active ? "Yes" : "No"}`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Menu entry point — renders the main menu
// ---------------------------------------------------------------------------

export function openModelMenu(prefixMessage?: string, tone: MenuResult["tone"] = "info", refreshHeader?: boolean): MenuResult {
  const active = getActiveProfile()
  const header = active
    ? `Active model: ${active.name} (${active.provider})`
    : "No active model"
  const menu = [
    `Model Configuration`,
    header,
    ``,
    `Options:`,
    `1. Select active model`,
    `2. Add new profile`,
    `3. Edit profile`,
    `4. Delete profile`,
    `5. Discover Ollama models`,
    `0. Exit`,
    ``,
    `Enter option number:`,
  ].join("\n")

  return {
    output: prefixMessage ? `${prefixMessage}\n\n${menu}` : menu,
    nextState: { step: "main", draft: {} },
    tone: tone,
    refreshHeader: refreshHeader,
  }
}

// ---------------------------------------------------------------------------
// Main dispatch: process input for current menu step
// ---------------------------------------------------------------------------

export async function processMenuInput(input: string, state: MenuState): Promise<MenuResult> {
  if (!state) return exitMenu("Menu closed.")
  const trimmed = input.trim()

  if (["salir", "exit", "q", "/model"].includes(trimmed.toLowerCase())) {
    return exitMenu("Menu closed.")
  }

  if (trimmed === "0" && state.step === "main") {
    return exitMenu("Menu closed.")
  }

  switch (state.step) {
    case "main":
      return handleMainMenu(trimmed)
    case "select":
      return handleSelect(trimmed)
    case "add-provider":
      return handleAddProvider(trimmed, state)
    case "add-baseurl":
      return await handleAddBaseUrl(trimmed, state)
    case "add-apikey":
      return handleAddApiKey(trimmed, state)
    case "add-model-pick":
      return handleAddModelPick(trimmed, state)
    case "add-model":
      return handleAddModel(trimmed, state)
    case "add-name":
      return handleAddName(trimmed, state)
    case "edit-pick":
      return handleEditPick(trimmed, state)
    case "edit-field":
      return handleEditField(trimmed, state)
    case "edit-value":
      return handleEditValue(trimmed, state)
    case "delete-pick":
      return handleDeletePick(trimmed, state)
    case "delete-confirm":
      return handleDeleteConfirm(trimmed, state)
    default:
      return exitMenu("Unknown state. Menu closed.")
  }
}

// ---------------------------------------------------------------------------
// Handlers for each step
// ---------------------------------------------------------------------------

async function handleMainMenu(input: string): Promise<MenuResult> {
  switch (input) {
    case "1": {
      // Select active profile
      const profiles = listProfiles()
      if (profiles.length === 0) {
        return {
          output: "No profiles to select. Use option 2 to add one.\n\nEnter option number:",
          nextState: { step: "main", draft: {} },
          tone: "error",
        }
      }
      const lines = [
        "Select profile to activate:",
        "",
        renderProfileList(),
        "",
        "Enter profile number (0 to go back):",
      ]
      return {
        output: lines.join("\n"),
        nextState: { step: "select", draft: {} },
        tone: "info",
      }
    }
    case "2": {
      // Add new profile — start wizard
      const providers = getAvailableProviders()
      const lines = [
        "[+] Add new profile",
        "",
        "Select provider:",
        ...providers.map((p, i) => `  ${i + 1}. ${p}`),
        "",
        "Enter number (0 to go back):",
      ]
      return {
        output: lines.join("\n"),
        nextState: { step: "add-provider", draft: {} },
        tone: "info",
      }
    }
    case "3": {
      // Edit profile
      const profiles = listProfiles()
      if (profiles.length === 0) {
        return {
          output: "No profiles to edit.\n\nEnter option number:",
          nextState: { step: "main", draft: {} },
          tone: "error",
        }
      }
      const lines = [
        "[*] Edit profile",
        "",
        renderProfileList(),
        "",
        "Enter profile number to edit (0 to go back):",
      ]
      return {
        output: lines.join("\n"),
        nextState: { step: "edit-pick", draft: {} },
        tone: "info",
      }
    }
    case "4": {
      // Delete profile
      const profiles = listProfiles()
      if (profiles.length === 0) {
        return {
          output: "No profiles to delete.\n\nEnter option number:",
          nextState: { step: "main", draft: {} },
          tone: "error",
        }
      }
      const lines = [
        "[-] Delete profile",
        "",
        renderProfileList(),
        "",
        "Enter profile number to delete (0 to go back):",
      ]
      return {
        output: lines.join("\n"),
        nextState: { step: "delete-pick", draft: {} },
        tone: "info",
      }
    }
    case "5": {
      // Discover Ollama
      return await handleOllamaDiscover()
    }
    default:
      return {
        output: `Invalid option "${input}".\n\nEnter a number between 0 and 5:`,
        nextState: { step: "main", draft: {} },
        tone: "error",
      }
  }
}

function handleSelect(input: string): MenuResult {
  if (input === "0") return openModelMenu()
  const index = Number.parseInt(input, 10) - 1
  const profile = getProfileByIndex(index)
  if (!profile) {
    return {
      output: `Profile #${input} not found.\n\nEnter profile number (0 to go back):`,
      nextState: { step: "select", draft: {} },
      tone: "error",
    }
  }
  try {
    activateProfileByIndex(index)
    applyProfileToEnv(process.env, profile)
    return openModelMenu(`Active model changed to: ${profile.name} (${profile.provider})`, "success", true)
  } catch (error) {
    return {
      output: `Error: ${error instanceof Error ? error.message : String(error)}`,
      nextState: { step: "select", draft: {} },
      tone: "error",
    }
  }
}

// --- Add wizard ---

function handleAddProvider(input: string, state: MenuState): MenuResult {
  if (input === "0") return openModelMenu()
  const providers = getAvailableProviders()
  const index = Number.parseInt(input, 10) - 1
  const provider = providers[index]
  if (!provider) {
    return {
      output: `Invalid option "${input}".\n\nEnter provider number:`,
      nextState: state,
      tone: "error",
    }
  }
  const defaults = getProviderDefaults(provider)
  const lines = [
    `Provider: ${provider}`,
    "",
    `Base URL [${defaults.baseUrl || "(required)"}]:`,
    `(press Enter for default, or specify a URL)`,
  ]
  return {
    output: lines.join("\n"),
    nextState: { ...state!, step: "add-baseurl", draft: { ...state!.draft, provider } },
    tone: "info",
  }
}

async function handleAddBaseUrl(input: string, state: MenuState): Promise<MenuResult> {
  const provider = state!.draft.provider as ModelProvider
  const defaults = getProviderDefaults(provider)
  const baseUrl = input || defaults.baseUrl

  if (!baseUrl) {
    return {
      output: "Base URL is required for this provider. Enter URL:",
      nextState: state,
      tone: "error",
    }
  }

  if (provider === "ollama") {
    const availableModels = await discoverProviderModels(provider, { baseUrl, apiKey: "" })
    if (availableModels.length > 0) {
      const lines = [
        `Provider: ${provider}`,
        `Base URL: ${baseUrl}`,
        "API Key: (not required)",
        "",
        "Available models:",
        ...availableModels.map((model, index) => `  ${index + 1}. ${model}`),
        "",
        "Enter model number, or type 'manual' to enter one yourself:",
      ]
      return {
        output: lines.join("\n"),
        nextState: { ...state!, step: "add-model-pick", draft: { ...state!.draft, baseUrl, apiKey: "" }, availableModels },
        tone: "info",
      }
    }

    return {
      output: [
        `Provider: ${provider}`,
        `Base URL: ${baseUrl}`,
        "API Key: (not required)",
        "",
        "Could not list models automatically for this Ollama endpoint.",
        "Enter model name manually:",
      ].join("\n"),
      nextState: { ...state!, step: "add-model", draft: { ...state!.draft, baseUrl, apiKey: "" } },
      tone: "info",
    }
  }

  const lines = [
    `Provider: ${provider}`,
    `Base URL: ${baseUrl}`,
    "",
    "API Key:",
  ]
  return {
    output: lines.join("\n"),
    nextState: { ...state!, step: "add-apikey", draft: { ...state!.draft, baseUrl } },
    tone: "info",
  }
}

async function handleAddApiKey(input: string, state: MenuState): Promise<MenuResult> {
  const apiKey = input.trim()
  const provider = state!.draft.provider as ModelProvider
  const baseUrl = state!.draft.baseUrl ?? ""
  const storedKey = readModelSettings().env.ANTHROPIC_AUTH_TOKEN.trim()
  const effectiveApiKey = apiKey || storedKey
  const needsApiKey = getProviderDefaults(provider).needsApiKey

  if (needsApiKey && !effectiveApiKey) {
    return {
      output: "API Key is required. Enter API Key:",
      nextState: state,
      tone: "error",
    }
  }

  const availableModels = await discoverProviderModels(provider, {
    baseUrl,
    apiKey: effectiveApiKey,
  })

  const nextState: MenuState = {
    ...state!,
    step: availableModels.length > 0 ? "add-model-pick" : "add-model",
    draft: { ...state!.draft, apiKey: effectiveApiKey },
    availableModels,
  }

  if (availableModels.length > 0) {
    const lines = [
      `Provider: ${provider}`,
      `Base URL: ${baseUrl}`,
      `API Key: ${effectiveApiKey ? "***" + effectiveApiKey.slice(-4) : "(not required)"}`,
      "",
      "Available models:",
      ...availableModels.map((model, index) => `  ${index + 1}. ${model}`),
      "",
      "Enter model number, or type 'manual' to enter one yourself:",
    ]
    return {
      output: lines.join("\n"),
      nextState,
      tone: "info",
    }
  }

  const lines = [
    `Provider: ${provider}`,
    `Base URL: ${baseUrl}`,
    `API Key: ${effectiveApiKey ? "***" + effectiveApiKey.slice(-4) : "(not required)"}`,
    "",
    "Could not list models automatically for this endpoint.",
    "Enter model name manually:",
  ]
  return {
    output: lines.join("\n"),
    nextState,
    tone: "info",
  }
}

function handleAddModelPick(input: string, state: MenuState): MenuResult {
  const normalized = input.trim().toLowerCase()
  if (normalized === "manual" || normalized === "m") {
    return {
      output: "Enter model name manually:",
      nextState: { ...state!, step: "add-model" },
      tone: "info",
    }
  }

  const models = state?.availableModels ?? []
  const index = Number.parseInt(input, 10) - 1
  const model = models[index]
  if (!model) {
    return {
      output: `Invalid option "${input}".\n\nEnter model number, or type 'manual':`,
      nextState: state,
      tone: "error",
    }
  }

  const lines = [
    `Provider: ${state!.draft.provider}`,
    `Base URL: ${state!.draft.baseUrl}`,
    `Model:    ${model}`,
    "",
    `Profile name [${model}]:`,
    "(press Enter to use model name)",
  ]
  return {
    output: lines.join("\n"),
    nextState: { ...state!, step: "add-name", draft: { ...state!.draft, model } },
    tone: "info",
  }
}

function handleAddModel(input: string, state: MenuState): MenuResult {
  const model = input.trim()
  if (!model) {
    return {
      output: "Model name is required. Enter name:",
      nextState: state,
      tone: "error",
    }
  }

  const lines = [
    `Provider: ${state!.draft.provider}`,
    `Base URL: ${state!.draft.baseUrl}`,
    `Model:    ${model}`,
    "",
    `Profile name [${model}]:`,
    "(press Enter to use model name)",
  ]
  return {
    output: lines.join("\n"),
    nextState: { ...state!, step: "add-name", draft: { ...state!.draft, model } },
    tone: "info",
  }
}

function handleAddName(input: string, state: MenuState): MenuResult {
  const name = input.trim() || state!.draft.model || "unnamed"
  const draft: ModelProfileDraft = {
    name,
    provider: state!.draft.provider as ModelProvider,
    baseUrl: state!.draft.baseUrl,
    apiKey: state!.draft.apiKey,
    model: state!.draft.model!,
  }
  try {
    const profile = addProfile(draft)
    // Auto-activate the new profile
    const profiles = listProfiles()
    const idx = profiles.findIndex(p => p.id === profile.id)
    if (idx >= 0) activateProfileByIndex(idx)
    applyProfileToEnv(process.env, profile)

    return openModelMenu(`Profile "${profile.name}" created and activated.`, "success", true)
  } catch (error) {
    return {
      output: `Error creating profile: ${error instanceof Error ? error.message : String(error)}`,
      nextState: { step: "main", draft: {} },
      tone: "error",
    }
  }
}

// --- Edit wizard ---

function handleEditPick(input: string, state: MenuState): MenuResult {
  if (input === "0") return openModelMenu()
  const index = Number.parseInt(input, 10) - 1
  const profile = getProfileByIndex(index)
  if (!profile) {
    return {
      output: `Profile #${input} not found.\n\nEnter profile number to edit (0 to go back):`,
      nextState: state,
      tone: "error",
    }
  }
  const lines = [
    `Editing: ${profile.name}`,
    "",
    renderProfileDetail(profile),
    "",
    "Select field:",
    "  1. Name",
    "  2. Provider",
    "  3. Base URL",
    "  4. API Key",
    "  5. Model",
    "  0. Back",
    "",
    "Enter number:",
  ]
  return {
    output: lines.join("\n"),
    nextState: { ...state!, step: "edit-field", draft: {}, targetId: profile.id },
    tone: "info",
  }
}

function handleEditField(input: string, state: MenuState): MenuResult {
  if (input === "0") return openModelMenu()
  const fieldMap: Record<string, string> = {
    "1": "name",
    "2": "provider",
    "3": "baseUrl",
    "4": "apiKey",
    "5": "model",
  }
  const field = fieldMap[input]
  if (!field) {
    return {
      output: `Invalid option "${input}".\n\nEnter field number:`,
      nextState: state,
      tone: "error",
    }
  }

  const labelMap: Record<string, string> = {
    name: "Name",
    provider: "Provider (openai_compatible, anthropic_compatible, ollama, minimax)",
    baseUrl: "Base URL",
    apiKey: "API Key",
    model: "Model",
  }

  return {
    output: `Enter new ${labelMap[field]}:`,
    nextState: { ...state!, step: "edit-value", editField: field },
    tone: "info",
  }
}

function handleEditValue(input: string, state: MenuState): MenuResult {
  const value = input.trim()
  if (!value) {
    return {
      output: "Value cannot be empty. Enter new value:",
      nextState: state,
      tone: "error",
    }
  }
  const field = state!.editField!
  try {
    const draft: Partial<ModelProfileDraft> = {}
    if (field === "name") draft.name = value
    else if (field === "provider") draft.provider = value as ModelProvider
    else if (field === "baseUrl") draft.baseUrl = value
    else if (field === "apiKey") draft.apiKey = value
    else if (field === "model") draft.model = value

    const updated = updateProfile(state!.targetId!, draft)
    // If this is the active profile, update env
    const active = getActiveProfile()
    if (active?.id === updated.id) {
      applyProfileToEnv(process.env, updated)
    }
    return openModelMenu(`Profile updated:\n\n${renderProfileDetail(updated)}`, "success", active?.id === updated.id)
  } catch (error) {
    return {
      output: `Error: ${error instanceof Error ? error.message : String(error)}`,
      nextState: { step: "main", draft: {} },
      tone: "error",
    }
  }
}

// --- Delete ---

function handleDeletePick(input: string, state: MenuState): MenuResult {
  if (input === "0") return openModelMenu()
  const index = Number.parseInt(input, 10) - 1
  const profile = getProfileByIndex(index)
  if (!profile) {
    return {
      output: `Profile #${input} not found.\n\nEnter profile number to delete (0 to go back):`,
      nextState: state,
      tone: "error",
    }
  }
  const lines = [
    `Are you sure you want to delete "${profile.name}"?`,
    "",
    renderProfileDetail(profile),
    "",
    "Type 'yes' to confirm or 'no' to cancel:",
  ]
  return {
    output: lines.join("\n"),
    nextState: { ...state!, step: "delete-confirm", targetId: profile.id },
    tone: "info",
  }
}

function handleDeleteConfirm(input: string, state: MenuState): MenuResult {
  if (["si", "sí", "yes", "y", "s"].includes(input.toLowerCase())) {
    try {
      const name = deleteProfile(state!.targetId!)
      // Update env if needed
      const active = getActiveProfile()
      if (active) applyProfileToEnv(process.env, active)
      return openModelMenu(`Profile "${name}" deleted.`, "success", true)
    } catch (error) {
      return {
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        nextState: { step: "main", draft: {} },
        tone: "error",
      }
    }
  }
  return openModelMenu()
}

// --- Ollama discover ---

async function handleOllamaDiscover(): Promise<MenuResult> {
  const models = await discoverOllamaModels()
  if (models.length === 0) {
    return {
      output: [
        "No models found in Ollama.",
        "",
        "Make sure Ollama is running at localhost:11434",
        "and you have models downloaded (ollama pull llama3).",
      ].join("\n"),
      nextState: { step: "main", draft: {} },
      tone: "error",
    }
  }
  const added = await addOllamaDiscoveredModels()
  if (added.length === 0) {
    // All already configured — show selection directly
    const lines = [
      `Models found in Ollama: ${models.join(", ")}`,
      "",
      "All are already configured as profiles.",
      "",
      "Select which one to activate:",
      "",
      renderProfileList(),
      "",
      "Enter profile number (0 to go back):",
    ]
    return {
      output: lines.join("\n"),
      nextState: { step: "select", draft: {} },
      tone: "info",
    }
  }
  const names = added.map(p => `  + ${p.name}`).join("\n")
  const lines = [
    `Discovered ${models.length} models in Ollama.`,
    `Added ${added.length} new profiles:`,
    "",
    names,
    "",
    "Select which one to activate:",
    "",
    renderProfileList(),
    "",
    "Enter profile number (0 to go back):",
  ]
  return {
    output: lines.join("\n"),
    nextState: { step: "select", draft: {} },
    tone: "success",
  }
}

// --- Helpers ---

function exitMenu(message: string): MenuResult {
  return {
    output: message,
    nextState: null,
    tone: "neutral",
  }
}
