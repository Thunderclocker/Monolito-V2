// shouldUseSandbox: decide si un command debería correr en sandbox OS-level.
// FC parity: extraído de shouldUseSandbox.ts. Sin sandbox real (bubblewrap/Seatbelt)
// en MVP — solo devuelve la decisión. El sandbox se implementaría con
// @anthropic-ai/sandbox-runtime si se quisiera en producción.

import { parseBashCommand } from "./parseForSecurity.ts"

const DANGEROUS_SANDBOX_COMMANDS = new Set([
  "rm", "mv", "cp", "dd", "shred", "chmod", "chown", "chgrp",
  "kill", "killall", "pkill", "fuser",
  "iptables", "ip", "ifconfig", "route", "mount", "umount",
  "systemctl", "service", "init", "shutdown", "reboot", "halt",
  "useradd", "userdel", "usermod", "groupadd", "groupdel", "groupmod",
  "crontab", "at", "batch",
  "curl", "wget", "nc", "netcat", "ssh", "scp", "rsync",
  "sudo", "su", "doas",
  "git push",  // mutations remotos
])

const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "stat", "file",
  "find", "grep", "rg", "ag", "echo", "printf", "true", "false",
  "pwd", "whoami", "date", "which", "type", "test",
])

export function shouldUseSandbox(command: string, options: { dangerouslyDisableSandbox?: boolean } = {}): boolean {
  if (options.dangerouslyDisableSandbox) return false
  const parsed = parseBashCommand(command)
  if (!parsed.allSegmentsParseOk) return false  // can't sandbox what we can't parse
  for (const segment of parsed.segments) {
    if (segment.argv.length === 0) continue
    const cmd = segment.argv[0]
    if (DANGEROUS_SANDBOX_COMMANDS.has(cmd)) return false
    if (READ_ONLY_COMMANDS.has(cmd)) continue
    // Read-only no requiere sandbox por default; mutaciones sí
  }
  return true
}
