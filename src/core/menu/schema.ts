/**
 * Declarative menu schema — pure data, no UI dependencies.
 *
 * Any menu can be described as a MenuDefinition and rendered by
 * a channel-specific adapter (CLI, Telegram, web).
 */

/** What an option does when selected */
export type MenuAction =
  | { type: "submenu"; menuId: string }
  | { type: "delegate"; menuDomain: MenuDomain }
  | { type: "exit" }

/** Known menu domains — maps to existing state machines */
export type MenuDomain = "model" | "channels" | "websearch" | "audio" | "system"

/** A single selectable option in a menu */
export type MenuOption = {
  /** Display key (e.g. "1", "a") */
  key: string
  /** Human-readable label */
  label: string
  /** What happens when selected */
  action: MenuAction
}

/** A complete menu screen definition */
export type MenuDefinition = {
  /** Unique identifier */
  id: string
  /** Title displayed at the top */
  title: string
  /** Optional subtitle / status line */
  subtitle?: string
  /** The options to display */
  options: MenuOption[]
  /** Tone for rendering */
  tone: "neutral" | "info" | "success" | "error"
  /** Optional prefix message (e.g. success/error from previous action) */
  prefixMessage?: string
}

/** Sentinel envelope returned by tools that want to open a menu in the CLI */
export type MenuSchemaEnvelope = {
  __menuSchema: true
  menu: MenuDefinition
}

/** Type guard to detect a MenuSchemaEnvelope in tool output */
export function isMenuSchemaEnvelope(value: unknown): value is MenuSchemaEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "__menuSchema" in value &&
    (value as Record<string, unknown>).__menuSchema === true &&
    "menu" in value
  )
}
