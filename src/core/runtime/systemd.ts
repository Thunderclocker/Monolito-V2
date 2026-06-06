import { execSync } from "node:child_process"
import { accessSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"
import { MONOLITO_ROOT } from "../system/root.ts"

interface SystemdLogger {
  warn: (message: string, data?: unknown) => void
  info: (message: string, data?: unknown) => void
  debug: (message: string, data?: unknown) => void
}

/**
 * The desired unit file content. Kept here as a single source of truth so
 * the runtime can detect when the on-disk unit has drifted and needs a
 * rewrite. We do NOT rewrite on every daemon start — that previously
 * caused a 5-15s crash loop where systemd would re-exec the daemon after
 * every failure, the daemon would re-write the unit, run daemon-reload,
 * and crash again on the next operation. Only rewrite if the file is
 * missing or its contents don't match this template.
 *
 * Robustness settings (vs the old unit):
 *   - Restart=always (was on-failure) — restart on ANY non-zero exit,
 *     including clean aborts, so a transient blip doesn't permanently
 *     disable the channel.
 *   - RestartSec=10 — give the network/DB time to settle.
 *   - StartLimitBurst=10, StartLimitIntervalSec=300 — 10 restarts in 5
 *     minutes, then systemd gives up. Prevents the infinite loop.
 *   - WatchdogSec=120 + Type=notify — systemd kills the daemon if it
 *     doesn't send watchdog=alive within 2 minutes. (Disabled by default
 *     until the daemon implements sd_notify; see below.)
 *   - TimeoutStopSec=30 — systemd SIGKILLs the daemon if it doesn't
 *     exit cleanly within 30s of SIGTERM.
 */
function buildServiceContent(escapedCwd: string, escapedExecPath: string, daemonLog: string): string {
  return `[Unit]
Description=Monolito V2 - AI Orchestration Daemon
After=network.target
StartLimitBurst=10
StartLimitIntervalSec=300

[Service]
Type=simple
ExecStart=/bin/sh -c 'cd "${escapedCwd}" && exec "${escapedExecPath}" --experimental-strip-types src/apps/daemon.ts --foreground'
Restart=always
RestartSec=10
TimeoutStopSec=30
StandardOutput=append:${daemonLog}
StandardError=append:${daemonLog}
Environment=NODE_ENV=production
Environment=MONOLITO_MODE=production

[Install]
WantedBy=default.target
`
}

export function ensureSystemdService(logger: SystemdLogger): void {
  if (os.platform() !== "linux") {
    return
  }

  try {
    const username = os.userInfo().username
    const lingerPath = `/var/lib/systemd/linger/${username}`

    try {
      accessSync(lingerPath)
    } catch {
      logger.info("Enabling systemd linger for user", { username })
      try {
        execSync(`loginctl enable-linger ${username}`, { stdio: "ignore" })
      } catch (err) {
        logger.warn("Failed to enable systemd linger (non-critical)", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const configDir = join(os.homedir(), ".config", "systemd", "user")
    mkdirSync(configDir, { recursive: true })

    const servicePath = join(configDir, "monolito.service")
    const daemonLog = join(MONOLITO_ROOT, "logs", "monolitod.log")

    // Escape double quotes in paths if any exist (highly unlikely, but makes it robust)
    const escapedCwd = process.cwd().replace(/"/g, '\\"')
    const escapedExecPath = process.execPath.replace(/"/g, '\\"')

    const desiredContent = buildServiceContent(escapedCwd, escapedExecPath, daemonLog)

    // Idempotent: only rewrite if the file is missing or drifted.
    let needsRewrite = true
    if (existsSync(servicePath)) {
      try {
        const existing = readFileSync(servicePath, "utf8")
        if (existing === desiredContent) {
          needsRewrite = false
        } else {
          logger.info("Systemd unit file drifted from desired template, rewriting", { path: servicePath })
        }
      } catch (err) {
        logger.warn("Could not read existing systemd unit, will rewrite", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (needsRewrite) {
      writeFileSync(servicePath, desiredContent)
      try {
        execSync("systemctl --user daemon-reload", { stdio: "ignore" })
      } catch (err) {
        logger.warn("Failed to run systemctl --user daemon-reload after service update", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      logger.info("Systemd user service installed", { path: servicePath })
    } else {
      logger.debug("Systemd unit is up to date, skipping rewrite", { path: servicePath })
    }
  } catch (error) {
    logger.warn("Failed to setup systemd service (non-critical)", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
