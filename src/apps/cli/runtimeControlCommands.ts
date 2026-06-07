// Slash commands that control the daemon or the current session.
//
// When the interactive composer is busy (a user turn is in flight) and
// the user types one of these, the TUI should NOT just enqueue the
// line behind the in-flight turn — it should abort the in-flight turn
// so the control command can run as soon as the daemon releases the
// session. The 06-jun-2026 incident showed that without this, a
// `/update` typed during a slow memory consolidation sat in the queue
// forever, and the daemon ended up killed by some other path while
// the queued command was never executed.
//
// Read-only commands (/help, /status, /sessions, /doctor, /config)
// are deliberately NOT in this set — they can wait without
// operational cost.
//
// Keep this set in sync with the slash commands listed in
// src/apps/cli/tui/autocomplete.ts and the special-cases in
// submitCurrentInput.
export const RUNTIME_CONTROL_COMMANDS: ReadonlySet<string> = new Set([
  "/update", // git fetch + reset + restart daemon
  "/stop",   // stop the daemon
  "/new",    // start a fresh session
  "/reset",  // reset current session
  "/quit",   // exit the CLI
  "/exit",   // alias of /quit
])

export function isRuntimeControlCommand(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith("/")) return false
  const cmd = trimmed.split(/\s+/)[0]?.toLowerCase() ?? ""
  return RUNTIME_CONTROL_COMMANDS.has(cmd)
}
