import { spawn } from "node:child_process"
import { DaemonClient } from "../core/client/daemonClient.ts"
import { parseArgs } from "./cli/args.ts"
import { runCliCommand } from "./cli/commands.ts"
import { handleCliFailure } from "./cli/output.ts"

async function ensureDaemon(client: DaemonClient) {
  try {
    await client.connect()
  } catch {
    // Daemon not running — spawn it
    const rootDir = process.cwd()
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
        return
      } catch {
        // keep waiting
      }
    }
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
