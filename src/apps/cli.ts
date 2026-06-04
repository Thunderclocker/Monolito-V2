import { spawn, execSync } from "node:child_process"
import { DaemonClient } from "../core/client/daemonClient.ts"
import { parseArgs } from "./cli/args.ts"
import { runCliCommand } from "./cli/commands.ts"
import { handleCliFailure } from "./cli/output.ts"

async function ensureDaemon(client: DaemonClient) {
  try {
    await client.connect()
  } catch {
    const rootDir = process.cwd()

    process.stderr.write(`[monolito] Daemon is not running. Attempting to start it...\n`)

    // Intentar iniciar el servicio systemd en Linux si está disponible
    if (process.platform === "linux") {
      try {
        execSync("systemctl --user start monolito.service", { stdio: "ignore" })
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 250))
          try {
            await client.connect()
            process.stderr.write(`[monolito] Daemon started via systemd.\n`)
            return
          } catch {
            // continuar esperando
          }
        }
      } catch (err) {
        process.stderr.write(`[monolito] systemctl start failed (${err instanceof Error ? err.message : String(err)}), falling back to manual spawn.\n`)
        // Fallback a spawn manual si systemd falla o no está configurado
      }
    }

    const daemonPath = `${rootDir}/src/apps/daemon.ts`
    const child = spawn(process.execPath, ["--experimental-strip-types", daemonPath], {
      cwd: rootDir,
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    // Wait for daemon to start (poll with ping)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250))
      try {
        await client.connect()
        process.stderr.write(`[monolito] Daemon started via manual spawn (pid=${child.pid}). Telegram channel will be active in this process.\n`)
        return
      } catch {
        // keep waiting
      }
    }
    // Final failure: surface a clear, actionable error to the user.
    process.stderr.write(
      `\n[monolito] ERROR: Daemon could not be started within 5 seconds.\n` +
      `  Without the daemon, Telegram messages, scheduled tasks, and\n` +
      `  background work will not be processed. To start the daemon manually:\n` +
      `    systemctl --user start monolito.service   # if systemd is set up\n` +
      `    # OR run monolito without arguments in another terminal.\n`,
    )
    throw new Error("Daemon failed to start within 5s")
  }
}

async function main() {
  const client = new DaemonClient(process.cwd())
  try {
    await ensureDaemon(client)
    await runCliCommand(client, parseArgs(process.argv.slice(2)))
  } finally {
    client.close()
  }
}

await main().catch(handleCliFailure)
