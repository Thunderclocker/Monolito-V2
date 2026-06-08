// Robust exclusive lock for the /update command.
//
// Extracted from runtime.ts so it can be unit-tested in isolation.
//
// Robustness contract:
//   1. If the lock file is missing → take it (happy path).
//   2. If the lock file exists and is valid (JSON with pid + startedAt)
//      AND the owning PID is alive AND the lock is recent (< 30 min) →
//      refuse with a clear message (another process is updating).
//   3. If the lock file is stale (PID dead, OR age > 30 min) → remove it
//      automatically and retry once. This handles crashes and SIGKILLs
//      that bypass the normal release() path.
//   4. If the lock file is corrupt (not JSON, missing fields) → remove it
//      and retry once. Defensive: catches filesystem corruption or a
//      half-written file from a previous crash mid-write.
//   5. If both acquisition attempts fail → return a clear error.

import { mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getPaths } from "../ipc/protocol.ts"
import { createLogger } from "../logging/logger.ts"

const logger = createLogger("update-lock")

/** A lock older than this is considered stale and removed automatically. */
export const MAX_UPDATE_LOCK_AGE_MS = 30 * 60 * 1000

/** Check if a PID is alive. Uses signal 0 (existence check, no actual signal sent). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // ESRCH = no such process. EPERM = exists but no permission (we still
    // count it as alive: the lock holder is real, just not ours to signal).
    return e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

export interface LockMetadata {
  pid: number
  startedAt: string
}

/**
 * Read the lock file metadata. Returns null if the file is missing, empty,
 * not valid JSON, or doesn't have the expected { pid, startedAt } shape.
 */
export function readUpdateLockMetadata(lockPath: string): LockMetadata | null {
  try {
    const content = readFileSync(lockPath, "utf8").trim()
    if (!content) return null
    const parsed = JSON.parse(content) as unknown
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).pid === "number" &&
      typeof (parsed as Record<string, unknown>).startedAt === "string"
    ) {
      return parsed as LockMetadata
    }
    return null
  } catch {
    return null
  }
}

export type AcquireUpdateLockResult =
  | { ok: true; lockPath: string; release: () => void }
  | { ok: false; message: string }

/**
 * Acquire the exclusive /update lock. See the file header for the
 * robustness contract.
 */
export function acquireUpdateLock(rootDir: string): AcquireUpdateLockResult {
  const paths = getPaths(rootDir)
  mkdirSync(paths.runDir, { recursive: true })
  const lockPath = join(paths.runDir, "update.lock")

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx")
      writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        "utf8",
      )
      return {
        ok: true as const,
        lockPath,
        release() {
          try {
            unlinkSync(lockPath)
          } catch {}
        },
      }
    } catch {
      // openSync with "wx" failed → the file already exists. Diagnose.
      const meta = readUpdateLockMetadata(lockPath)

      if (!meta) {
        // Lock is corrupt or unreadable. Remove and retry.
        logger.warn("update lock file is corrupt, removing", { lockPath })
        try {
          unlinkSync(lockPath)
        } catch {}
        continue
      }

      const alive = isPidAlive(meta.pid)
      const startedAtMs = new Date(meta.startedAt).getTime()
      const ageMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : Number.POSITIVE_INFINITY

      if (alive && ageMs < MAX_UPDATE_LOCK_AGE_MS) {
        // Active update. Refuse with diagnostics.
        const ageSec = Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : "unknown"
        return {
          ok: false as const,
          message:
            `Update already in progress in another Monolito process ` +
            `(pid=${meta.pid}, age=${ageSec}s). Wait for it to finish and try /update again.`,
        }
      }

      // Stale: either the PID is dead, or the lock is older than the
      // safety threshold (PID could be a reused PID by an unrelated process).
      logger.warn("removing stale update lock", {
        pid: meta.pid,
        pidAlive: alive,
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
        startedAt: meta.startedAt,
      })
      try {
        unlinkSync(lockPath)
      } catch {}
      // Loop retries the acquisition.
      continue
    }
  }

  // Both attempts failed. Should not happen unless filesystem is wedged
  // or there's a race with another process.
  return {
    ok: false as const,
    message:
      "Failed to acquire update lock after removing stale lock. " +
      "Check filesystem permissions on the run/ directory and retry /update.",
  }
}
