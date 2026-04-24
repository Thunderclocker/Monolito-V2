/**
 * Builds the Master Configuration Hub dashboard.
 *
 * Reads existing configs to show a status summary on each option.
 * Synchronous — no Docker calls; detailed status is shown inside sub-menus.
 */
import { readChannelsConfig } from "../channels/config.ts"
import { readWebSearchConfig } from "../websearch/config.ts"
import { getActiveProfile } from "../runtime/modelRegistry.ts"
import type { MenuDefinition, MenuSchemaEnvelope } from "./schema.ts"

export function buildMasterDashboard(prefixMessage?: string): MenuSchemaEnvelope {
  const activeProfile = getActiveProfile()
  const modelStatus = activeProfile
    ? `${activeProfile.name} (${activeProfile.provider})`
    : "No active model"

  const channelsConfig = readChannelsConfig()
  const telStatus = channelsConfig.telegram?.enabled ? "On" : "Off"

  const wsConfig = readWebSearchConfig()
  const wsStatus = wsConfig.provider === "searxng" ? "SearxNG" : "Default"

  const menu: MenuDefinition = {
    id: "master-dashboard",
    title: "Configuration Hub",
    subtitle: `Model: ${modelStatus}`,
    tone: "info",
    prefixMessage,
    options: [
      {
        key: "1",
        label: `\u{1F9E0} Models  [${modelStatus}]`,
        action: { type: "delegate", menuDomain: "model" },
      },
      {
        key: "2",
        label: `\u{1F4AC} Channels  [Telegram ${telStatus}]`,
        action: { type: "delegate", menuDomain: "channels" },
      },
      {
        key: "3",
        label: `\u{1F50D} Web Search  [${wsStatus}]`,
        action: { type: "delegate", menuDomain: "websearch" },
      },
      {
        key: "0",
        label: "Exit",
        action: { type: "exit" },
      },
    ],
  }

  return { __menuSchema: true, menu }
}
