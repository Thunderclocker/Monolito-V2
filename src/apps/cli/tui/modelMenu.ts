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
  getProfileById,
  getProviderDefaults,
  getAvailableProviders,
  discoverOllamaModels,
  discoverProviderModels,
  addOllamaDiscoveredModels,
  redactProfile,
} from "../../../core/runtime/modelRegistry.ts"
import { applyProfileToEnv, readModelSettings } from "../../../core/runtime/modelConfig.ts"
import type { MenuState, MenuStep } from "./types.ts"
import {
  generatePKCE,
  XAI_OAUTH_AUTHORIZE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_SCOPE,
  XAI_OAUTH_REDIRECT_PORT,
  XAI_OAUTH_REDIRECT_PATH
} from "../../../core/runtime/providers/grokAuth.ts"

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
    `  Reasoning: ${redacted.reasoningLevel ?? "off"}`,
    `  Active:    ${redacted.active ? "Yes" : "No"}`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Menu rendering helpers — always re-show full option lists on re-prompts
// ---------------------------------------------------------------------------

function renderMainMenuText(): string {
  const active = getActiveProfile()
  const header = active
    ? `Active model: ${active.name} (${active.provider})`
    : "No active model"
  return [
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
}

function renderSelectMenuText(): string {
  return [
    "Select profile to activate:",
    "",
    renderProfileList(),
    "",
    "Enter profile number (0 to go back):",
  ].join("\n")
}

function renderAddProviderMenuText(): string {
  const providers = getAvailableProviders()
  return [
    "[+] Add new profile",
    "",
    "Select provider:",
    ...providers.map((p, i) => `  ${i + 1}. ${p}`),
    "",
    "Enter number (0 to go back):",
  ].join("\n")
}

function renderEditPickMenuText(): string {
  return [
    "[*] Edit profile",
    "",
    renderProfileList(),
    "",
    "Enter profile number to edit (0 to go back):",
  ].join("\n")
}

function renderDeletePickMenuText(): string {
  return [
    "[-] Delete profile",
    "",
    renderProfileList(),
    "",
    "Enter profile number to delete (0 to go back):",
  ].join("\n")
}

function renderAddModelPickMenuText(state: MenuState): string {
  const provider = state!.draft.provider as ModelProvider
  const baseUrl = state!.draft.baseUrl ?? ""
  const apiKey = state!.draft.apiKey ?? ""
  const models = state!.availableModels ?? []
  const lines = [
    provider === "minimax" ? "MiniMax — select model:" : `Provider: ${provider}`,
    ...(provider === "minimax"
      ? []
      : [`Base URL: ${baseUrl}`, `API Key: ${apiKey ? "***" + apiKey.slice(-4) : "(not required)"}`, ""]),
    ...models.map((model, index) => `  ${index + 1}. ${model}`),
    "",
    provider === "minimax"
      ? "Enter model number:"
      : "Enter model number, or type 'manual' to enter one yourself:",
  ]
  return lines.join("\n")
}

function menuOutput(menu: string, prefixMessage?: string): string {
  return prefixMessage ? `${prefixMessage}\n\n${menu}` : menu
}

function openMainMenu(
  prefixMessage?: string,
  tone: MenuResult["tone"] = "info",
  refreshHeader?: boolean,
): MenuResult {
  return {
    output: menuOutput(renderMainMenuText(), prefixMessage),
    nextState: { step: "main", draft: {} },
    tone,
    refreshHeader,
  }
}

function openSelectMenu(prefixMessage?: string, tone: MenuResult["tone"] = "info", refreshHeader?: boolean): MenuResult {
  return {
    output: menuOutput(renderSelectMenuText(), prefixMessage),
    nextState: { step: "select", draft: {} },
    tone,
    refreshHeader,
  }
}

function openAddProviderMenu(
  prefixMessage?: string,
  tone: MenuResult["tone"] = "info",
  state: MenuState = { step: "add-provider", draft: {} },
): MenuResult {
  const baseState: NonNullable<MenuState> = state ?? { step: "add-provider", draft: {} }
  return {
    output: menuOutput(renderAddProviderMenuText(), prefixMessage),
    nextState: { ...baseState, step: "add-provider", draft: baseState.draft ?? {} },
    tone,
  }
}

function openEditPickMenu(prefixMessage?: string, tone: MenuResult["tone"] = "info"): MenuResult {
  return {
    output: menuOutput(renderEditPickMenuText(), prefixMessage),
    nextState: { step: "edit-pick", draft: {} },
    tone,
  }
}

function openDeletePickMenu(prefixMessage?: string, tone: MenuResult["tone"] = "info"): MenuResult {
  return {
    output: menuOutput(renderDeletePickMenuText(), prefixMessage),
    nextState: { step: "delete-pick", draft: {} },
    tone,
  }
}

function openAddModelPickMenu(
  state: MenuState,
  prefixMessage?: string,
  tone: MenuResult["tone"] = "info",
): MenuResult {
  return {
    output: menuOutput(renderAddModelPickMenuText(state), prefixMessage),
    nextState: state,
    tone,
  }
}

/** Menu entry point — renders the main menu */
export function openModelMenu(
  prefixMessage?: string,
  tone: MenuResult["tone"] = "info",
  refreshHeader?: boolean,
): MenuResult {
  return openMainMenu(prefixMessage, tone, refreshHeader)
}

// ---------------------------------------------------------------------------
// Main dispatch: process input for current menu step
// ---------------------------------------------------------------------------

export async function processMenuInput(input: string, state: MenuState): Promise<MenuResult> {
  if (!state) return exitMenu("Menu closed.")
  const trimmed = input.trim()

  if (trimmed.toLowerCase() === "/model") {
    return openMainMenu()
  }

  if (["salir", "exit", "q"].includes(trimmed.toLowerCase())) {
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
    case "xai-oauth-code":
      return await handleXaiOAuthCode(trimmed, state)
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
      const profiles = listProfiles()
      if (profiles.length === 0) {
        return openMainMenu("No profiles to select. Use option 2 to add one.", "error")
      }
      return openSelectMenu()
    }
    case "2": {
      return openAddProviderMenu()
    }
    case "3": {
      const profiles = listProfiles()
      if (profiles.length === 0) {
        return openMainMenu("No profiles to edit.", "error")
      }
      return openEditPickMenu()
    }
    case "4": {
      const profiles = listProfiles()
      if (profiles.length === 0) {
        return openMainMenu("No profiles to delete.", "error")
      }
      return openDeletePickMenu()
    }
    case "5": {
      return await handleOllamaDiscover()
    }
    default:
      return openMainMenu(`Invalid option "${input}".`, "error")
  }
}

function handleSelect(input: string): MenuResult {
  if (input === "0") return openMainMenu()
  const index = Number.parseInt(input, 10) - 1
  const profile = getProfileByIndex(index)
  if (!profile) {
    return openSelectMenu(`Profile #${input} not found.`, "error")
  }
  try {
    activateProfileByIndex(index)
    applyProfileToEnv(process.env, profile)
    return openMainMenu(`Active model changed to: ${profile.name} (${profile.provider})`, "success", true)
  } catch (error) {
    return openSelectMenu(`Error: ${error instanceof Error ? error.message : String(error)}`, "error")
  }
}

// --- Add wizard ---

function handleAddProvider(input: string, state: MenuState): MenuResult {
  if (input === "0") return openMainMenu()
  const providers = getAvailableProviders()
  const index = Number.parseInt(input, 10) - 1
  const provider = providers[index]
  if (!provider) {
    return openAddProviderMenu(`Invalid option "${input}".`, "error", state)
  }
  if (provider === "xai-oauth") {
    const pkce = generatePKCE();
    const redirectUri = `http://127.0.0.1:${XAI_OAUTH_REDIRECT_PORT}${XAI_OAUTH_REDIRECT_PATH}`;
    const authUrl = `${XAI_OAUTH_AUTHORIZE_URL}?response_type=code&client_id=${XAI_OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(XAI_OAUTH_SCOPE)}&code_challenge=${pkce.code_challenge}&code_challenge_method=S256&state=${pkce.state}&nonce=${pkce.nonce}&plan=generic&referrer=legacy runtime`;

    const lines = [
      `[+] Configurando Grok OAuth (xai-oauth)`,
      "",
      "1. Abre este enlace en tu navegador para iniciar sesión:",
      `\x1b[36m${authUrl}\x1b[0m`,
      "",
      "2. Una vez autorizado, el navegador intentará redirigir.",
      "Copia el código ('code=...') o la URL de redirección completa fallida.",
      "",
      "Introduce el código o la URL aquí para completar la vinculación (0 para volver):",
    ]

    return {
      output: lines.join("\n"),
      nextState: {
        step: "xai-oauth-code",
        draft: {
          provider,
          baseUrl: "https://api.x.ai",
          apiKey: "",
          model: "grok-4.3",
        },
        targetId: pkce.code_verifier,
        editField: pkce.code_challenge,
        availableModels: [pkce.state],
      },
      tone: "info",
    }
  }
  const defaults = getProviderDefaults(provider)
  if (provider === "minimax") {
    const baseUrl = defaults.baseUrl
    const lines = [
      `[+] Add new profile — MiniMax`,
      "",
      `Base URL: ${baseUrl}`,
      "",
      "API Key:",
    ]
    return {
      output: lines.join("\n"),
      nextState: {
        ...state!,
        step: "add-apikey",
        draft: { ...state!.draft, provider, baseUrl },
      },
      tone: "info",
    }
  }
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
    const lines = [
      `Provider: ${provider}`,
      "",
      `Base URL [${defaults.baseUrl || "(required)"}]:`,
      `(press Enter for default, or specify a URL)`,
      "",
      "Base URL is required for this provider. Enter URL:",
    ]
    return {
      output: lines.join("\n"),
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
    const lines = [
      `Provider: ${provider}`,
      `Base URL: ${baseUrl}`,
      "",
      "API Key:",
      "",
      "API Key is required. Enter API Key:",
    ]
    return {
      output: lines.join("\n"),
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
    return openAddModelPickMenu(nextState)
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
  const provider = state!.draft.provider as ModelProvider
  const normalized = input.trim().toLowerCase()
  if (provider !== "minimax" && (normalized === "manual" || normalized === "m")) {
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
    return openAddModelPickMenu(state, `Invalid option "${input}".`, "error")
  }

  if (provider === "minimax") {
    try {
      const draft: ModelProfileDraft = {
        name: model,
        provider,
        baseUrl: state!.draft.baseUrl,
        apiKey: state!.draft.apiKey,
        model,
      }
      const profile = addProfile(draft)
      const profiles = listProfiles()
      const idx = profiles.findIndex(p => p.id === profile.id)
      if (idx >= 0) activateProfileByIndex(idx)
      applyProfileToEnv(process.env, profile)
      return openMainMenu(`MiniMax configured: ${profile.model} (active).`, "success", true)
    } catch (error) {
      return openMainMenu(`Error configuring MiniMax: ${error instanceof Error ? error.message : String(error)}`, "error")
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
  const provider = state!.draft.provider as ModelProvider
  if (!model) {
    const lines = [
      `Provider: ${state!.draft.provider}`,
      `Base URL: ${state!.draft.baseUrl}`,
      `Model:    ${state!.draft.model ?? ""}`,
      "",
      `Profile name [${state!.draft.model ?? "unnamed"}]:`,
      "(press Enter to use model name)",
      "",
      "Model name is required. Enter name:",
    ]
    return {
      output: lines.join("\n"),
      nextState: state,
      tone: "error",
    }
  }

  if (provider === "minimax") {
    try {
      const draft: ModelProfileDraft = {
        name: model,
        provider,
        baseUrl: state!.draft.baseUrl,
        apiKey: state!.draft.apiKey,
        model,
      }
      const profile = addProfile(draft)
      const profiles = listProfiles()
      const idx = profiles.findIndex(p => p.id === profile.id)
      if (idx >= 0) activateProfileByIndex(idx)
      applyProfileToEnv(process.env, profile)
      return openMainMenu(`MiniMax configured: ${profile.model} (active).`, "success", true)
    } catch (error) {
      return openMainMenu(`Error configuring MiniMax: ${error instanceof Error ? error.message : String(error)}`, "error")
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

    return openMainMenu(`Profile "${profile.name}" created and activated.`, "success", true)
  } catch (error) {
    return openMainMenu(
      `Error creating profile: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    )
  }
}

// --- Edit wizard ---

function handleEditPick(input: string, state: MenuState): MenuResult {
  if (input === "0") return openMainMenu()
  const index = Number.parseInt(input, 10) - 1
  const profile = getProfileByIndex(index)
  if (!profile) {
    return openEditPickMenu(`Profile #${input} not found.`, "error")
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
    "  6. Reasoning Level",
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
  if (input === "0") return openMainMenu()
  const fieldMap: Record<string, string> = {
    "1": "name",
    "2": "provider",
    "3": "baseUrl",
    "4": "apiKey",
    "5": "model",
    "6": "reasoningLevel",
  }
  const field = fieldMap[input]
  if (!field) {
    const profile = getProfileById(state!.targetId!)
    const lines = profile
      ? [
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
          "  6. Reasoning Level",
          "  0. Back",
          "",
          `Invalid option "${input}".`,
          "",
          "Enter number:",
        ]
      : [`Invalid option "${input}".`, "", "Enter number:"]
    return {
      output: lines.join("\n"),
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
    reasoningLevel: "Reasoning Level (low, medium, high, off)",
  }

  return {
    output: `Enter new ${labelMap[field]}:`,
    nextState: { ...state!, step: "edit-value", editField: field },
    tone: "info",
  }
}

function handleEditValue(input: string, state: MenuState): MenuResult {
  const value = input.trim()
  const field = state!.editField!
  const labelMap: Record<string, string> = {
    name: "Name",
    provider: "Provider (openai_compatible, anthropic_compatible, ollama, minimax)",
    baseUrl: "Base URL",
    apiKey: "API Key",
    model: "Model",
    reasoningLevel: "Reasoning Level (low, medium, high, off)",
  }
  if (!value) {
    return {
      output: [`Enter new ${labelMap[field]}:`, "", "Value cannot be empty. Enter new value:"].join("\n"),
      nextState: state,
      tone: "error",
    }
  }
  try {
    const draft: Partial<ModelProfileDraft> = {}
    if (field === "name") draft.name = value
    else if (field === "provider") draft.provider = value as ModelProvider
    else if (field === "baseUrl") draft.baseUrl = value
    else if (field === "apiKey") draft.apiKey = value
    else if (field === "model") draft.model = value
    else if (field === "reasoningLevel") {
      const val = value.toLowerCase()
      if (!["low", "medium", "high", "off"].includes(val)) {
        return {
          output: [
            `Enter new ${labelMap[field]}:`,
            "",
            "Invalid reasoning level. Must be low, medium, high, or off. Enter value:",
          ].join("\n"),
          nextState: state,
          tone: "error",
        }
      }
      draft.reasoningLevel = val as any
    }

    const updated = updateProfile(state!.targetId!, draft)
    // If this is the active profile, update env
    const active = getActiveProfile()
    if (active?.id === updated.id) {
      applyProfileToEnv(process.env, updated)
    }
    return openMainMenu(`Profile updated: ${updated.name}`, "success", active?.id === updated.id)
  } catch (error) {
    return openMainMenu(`Error: ${error instanceof Error ? error.message : String(error)}`, "error")
  }
}

// --- Delete ---

function handleDeletePick(input: string, state: MenuState): MenuResult {
  if (input === "0") return openMainMenu()
  const index = Number.parseInt(input, 10) - 1
  const profile = getProfileByIndex(index)
  if (!profile) {
    return openDeletePickMenu(`Profile #${input} not found.`, "error")
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
      return openMainMenu(`Profile "${name}" deleted.`, "success", true)
    } catch (error) {
      return openMainMenu(`Error: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }
  return openMainMenu()
}

// --- Ollama discover ---

async function handleOllamaDiscover(): Promise<MenuResult> {
  const models = await discoverOllamaModels()
  if (models.length === 0) {
    return openMainMenu(
      [
        "No models found in Ollama.",
        "",
        "Make sure Ollama is running at localhost:11434",
        "and you have models downloaded (ollama pull llama3).",
      ].join("\n"),
      "error",
    )
  }
  const added = await addOllamaDiscoveredModels()
  if (added.length === 0) {
    return openSelectMenu(
      [
        `Models found in Ollama: ${models.join(", ")}`,
        "",
        "All are already configured as profiles.",
      ].join("\n"),
    )
  }
  const names = added.map(p => `  + ${p.name}`).join("\n")
  return openSelectMenu(
    [`Discovered ${models.length} models in Ollama.`, `Added ${added.length} new profiles:`, "", names].join("\n"),
    "success",
  )
}

async function handleXaiOAuthCode(input: string, state: MenuState): Promise<MenuResult> {
  if (input === "0") return openMainMenu()
  const cleanedInput = input.trim()
  if (!cleanedInput) {
    return {
      output: "El código no puede estar vacío. Introduce el código de autorización o URL:",
      nextState: state,
      tone: "error",
    }
  }

  const provider = state!.draft.provider as ModelProvider
  const code_verifier = state!.targetId!
  const code_challenge = state!.editField!
  const expectedState = state!.availableModels?.[0] ?? ""

  let incomingCode: string | null = null;
  let incomingState: string | null = null;
  let incomingError: string | null = null;

  if (cleanedInput.startsWith("http://") || cleanedInput.startsWith("https://")) {
    try {
      const urlObj = new URL(cleanedInput);
      incomingCode = urlObj.searchParams.get("code");
      incomingState = urlObj.searchParams.get("state");
      incomingError = urlObj.searchParams.get("error");
    } catch (err) {
      return {
        output: `Error al analizar la URL: ${err instanceof Error ? err.message : String(err)}\n\nIntroduce el código o la URL de nuevo:`,
        nextState: state,
        tone: "error",
      }
    }
  } else {
    // Treat as raw authorization code
    incomingCode = cleanedInput;
    incomingState = expectedState; // bypass state check by matching current state
  }

  if (incomingError) {
    return {
      output: `El servidor OAuth devolvió un error: ${incomingError}\n\nIntroduce el código o la URL de nuevo:`,
      nextState: state,
      tone: "error",
    }
  }
  if (incomingState !== expectedState) {
    return {
      output: "Mismatched OAuth state parameter (posible CSRF).\n\nIntroduce el código o la URL de nuevo:",
      nextState: state,
      tone: "error",
    }
  }
  if (!incomingCode) {
    return {
      output: "No se pudo extraer el código de autorización de la entrada provista.\n\nIntroduce el código o la URL de nuevo:",
      nextState: state,
      tone: "error",
    }
  }

  const { exchangeCodeForTokens, saveGrokTokens } = await import("../../../core/runtime/providers/grokAuth.ts")
  const redirectUri = `http://127.0.0.1:${XAI_OAUTH_REDIRECT_PORT}${XAI_OAUTH_REDIRECT_PATH}`;

  try {
    const tokens = await exchangeCodeForTokens(incomingCode, code_verifier, code_challenge, redirectUri);
    await saveGrokTokens(tokens);

    // Create the profile and activate it
    const draft: ModelProfileDraft = {
      name: "Grok SuperGrok (OAuth)",
      provider: "xai-oauth",
      baseUrl: "https://api.x.ai",
      apiKey: "",
      model: "grok-4.3",
    }
    const profile = addProfile(draft)
    const profiles = listProfiles()
    const idx = profiles.findIndex(p => p.id === profile.id)
    if (idx >= 0) activateProfileByIndex(idx)
    applyProfileToEnv(process.env, profile)

    return openMainMenu(`Profile "${profile.name}" created and activated successfully!`, "success", true)
  } catch (err) {
    return {
      output: `Error de intercambio de tokens: ${err instanceof Error ? err.message : String(err)}\n\nIntroduce el código o la URL de nuevo:`,
      nextState: state,
      tone: "error",
    }
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
