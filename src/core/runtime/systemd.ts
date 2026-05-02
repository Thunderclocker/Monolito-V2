import { execSync } from "node:child_process"
import { accessSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"

interface SystemdLogger {
  warn: (message: string, data?: unknown) => void
  info: (message: string, data?: unknown) => void
  debug: (message: string, data?: unknown) => void
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
      execSync(`loginctl enable-linger ${username}`, { stdio: "ignore" })
    }

    const configDir = join(os.homedir(), ".config", "systemd", "user")
    mkdirSync(configDir, { recursive: true })

    const servicePath = join(configDir, "monolito.service")
    const daemonLog = join(os.homedir(), ".monolito-v2", "logs", "monolitod.log")

    const serviceContent = `[Unit]
Description=Monolito V2 - AI Orchestration Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${process.cwd()}
ExecStart=${process.execPath} --experimental-strip-types ${process.cwd()}/src/apps/daemon.ts --foreground
Restart=always
RestartSec=5
StandardOutput=append:${daemonLog}
StandardError=append:${daemonLog}
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`

    writeFileSync(servicePath, serviceContent)
    logger.info("Systemd user service installed", { path: servicePath })
  } catch (error) {
    logger.warn("Failed to setup systemd service (non-critical)", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
