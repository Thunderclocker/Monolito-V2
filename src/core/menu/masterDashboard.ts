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
    : "Sin modelo activo"

  const channelsConfig = readChannelsConfig()
  const telStatus = channelsConfig.telegram?.enabled ? "On" : "Off"

  const wsConfig = readWebSearchConfig()
  const wsStatus = wsConfig.provider === "searxng" ? "SearxNG" : "Default"

  const ttsManaged = channelsConfig.tts?.managed ? "managed" : "externo"
  const sttManaged = channelsConfig.stt?.managed ? "managed" : "externo"
  const audioStatus = `TTS: ${ttsManaged}, STT: ${sttManaged}`

  const menu: MenuDefinition = {
    id: "master-dashboard",
    title: "Hub de Configuracion Maestro",
    subtitle: `Modelo: ${modelStatus}`,
    tone: "info",
    prefixMessage,
    options: [
      {
        key: "1",
        label: `\u{1F9E0} Modelos  [${modelStatus}]`,
        action: { type: "delegate", menuDomain: "model" },
      },
      {
        key: "2",
        label: `\u{1F4AC} Canales  [Telegram ${telStatus}]`,
        action: { type: "delegate", menuDomain: "channels" },
      },
      {
        key: "3",
        label: `\u{1F50D} Busqueda Web  [${wsStatus}]`,
        action: { type: "delegate", menuDomain: "websearch" },
      },
      {
        key: "4",
        label: `\u{1F5E3}\u{FE0F} Audio y Voz  [${audioStatus}]`,
        action: { type: "delegate", menuDomain: "audio" },
      },
      {
        key: "5",
        label: `\u{1F6E0}\u{FE0F} Sistema`,
        action: { type: "delegate", menuDomain: "system" },
      },
      {
        key: "0",
        label: "Salir",
        action: { type: "exit" },
      },
    ],
  }

  return { __menuSchema: true, menu }
}
