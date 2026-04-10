import { spawn } from "node:child_process"
import { openSync } from "node:fs"
import { MonolitoV2Daemon } from "../core/runtime/daemon.ts"
import { ensureDirs, readDaemonLock } from "../core/ipc/protocol.ts"

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function runDaemon() {
  const rootDir = process.cwd()
  const daemon = new MonolitoV2Daemon(rootDir)
  try {
    await daemon.start()
  } catch (error) {
    daemon.stop()
    throw error
  }

  const shutdown = (reason?: unknown) => {
    if (reason instanceof Error) {
      process.stderr.write(`daemon error: ${reason.message}\n`)
    } else if (typeof reason === "string" && reason.length > 0) {
      process.stderr.write(`daemon error: ${reason}\n`)
    }
    daemon.stop()
    process.exit(reason ? 1 : 0)
  }

  process.on("SIGINT", () => shutdown())
  process.on("SIGTERM", () => shutdown())
  process.on("uncaughtException", error => shutdown(error))
  process.on("unhandledRejection", reason => shutdown(reason))
}

function startDetachedDaemon() {
  const rootDir = process.cwd()
  const paths = ensureDirs(rootDir)
  const lock = readDaemonLock(rootDir)

  if (lock && isProcessRunning(lock.pid)) {
    process.stdout.write(`monolitod-v2 already running\n`)
    process.stdout.write(`pid: ${lock.pid}\n`)
    process.stdout.write(`log: ${paths.daemonLog}\n`)
    process.stdout.write(`lock: ${paths.lockFile}\n`)
    return
  }

  const stdout = openSync(paths.daemonLog, "a")
  const stderr = openSync(paths.daemonLog, "a")
  const args = ["--experimental-strip-types", import.meta.filename, "--foreground"]
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    detached: true,
    stdio: ["ignore", stdout, stderr],
  })
  child.unref()
  process.stdout.write(`monolitod-v2 starting\n`)
  process.stdout.write(`pid: ${child.pid}\n`)
  process.stdout.write(`process: ${process.execPath} ${args.join(" ")}\n`)
  process.stdout.write(`log: ${paths.daemonLog}\n`)
  process.stdout.write(`pid file: ${paths.pidFile}\n`)
  process.stdout.write(`lock: ${paths.lockFile}\n`)
}

if (process.argv.includes("--foreground")) {
  try {
    await runDaemon()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(message.includes("already running") ? 0 : 1)
  }
} else {
  startDetachedDaemon()
}
