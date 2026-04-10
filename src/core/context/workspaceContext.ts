import { isBootstrapPendingContent, type BootWingEntry } from "../bootstrap/bootWings.ts"
import { listBootEntries } from "../session/store.ts"

export type WorkspaceBootstrapContext = {
  entries: BootWingEntry[]
  profileId: string
  isMainSession: boolean
  bootstrapPending: boolean
}

const BOOTSTRAP_MAX_ENTRY_CHARS = 20_000
const BOOTSTRAP_TOTAL_MAX_CHARS = 150_000

export function getWorkspaceContext(rootDir: string, profileId = "default", options?: { isMainSession?: boolean }): WorkspaceBootstrapContext {
  const isMainSession = options?.isMainSession ?? true
  const entries = listBootEntries(rootDir, profileId, {
    includeMemory: isMainSession,
    maxCharsPerEntry: BOOTSTRAP_MAX_ENTRY_CHARS,
    maxTotalChars: BOOTSTRAP_TOTAL_MAX_CHARS,
  })
  const bootstrap = entries.find(entry => entry.wing === "BOOT_BOOTSTRAP")

  return {
    entries,
    profileId,
    isMainSession,
    bootstrapPending: bootstrap ? isBootstrapPendingContent(bootstrap.content) : false,
  }
}
