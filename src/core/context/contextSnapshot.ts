import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "../ipc/protocol.ts";
import type { ConversationMessage } from "../runtime/providers/types.ts";
import { createLogger } from "../logging/logger.ts"

const logger = createLogger("context-snapshot")


/**
 * Saves a full backup snapshot of the active conversation messages to the state/snapshots directory
 * in case of unrecoverable context overflow or extreme failure.
 */
export function saveEmergencySnapshot(
  rootDir: string,
  sessionId: string,
  messages: ConversationMessage[]
): string {
  try {
    const paths = getPaths(rootDir);
    const snapshotsDir = join(paths.baseDir, "snapshots");
    mkdirSync(snapshotsDir, { recursive: true });

    const filename = `session-${sessionId}-${Date.now()}.json`;
    const fullPath = join(snapshotsDir, filename);

    writeFileSync(fullPath, JSON.stringify(messages, null, 2), "utf8");
    return fullPath;
  } catch (err) {
    logger.error("Failed to save emergency snapshot", { errorMessage: String(err), errorStack: (err instanceof Error ? err.stack : undefined) })
    // Return a path in workspace as fallback
    try {
      const fallbackPath = join(rootDir, `emergency-snapshot-${sessionId}-${Date.now()}.json`);
      writeFileSync(fallbackPath, JSON.stringify(messages, null, 2), "utf8");
      return fallbackPath;
    } catch {
      return "failed-to-save";
    }
  }
}
