// Command semantics interpreter: exit code → human-readable message.
// FC parity: extraído de commandSemantics.ts de upstream.

const SEARCH_COMMAND_EXIT_CODES: Record<string, { code: number; message: string }> = {
  grep: { code: 1, message: "no matches found" },
  rg: { code: 1, message: "no matches found" },
  find: { code: 1, message: "partial results" },
  diff: { code: 1, message: "files differ" },
  cmp: { code: 1, message: "files differ" },
  test: { code: 1, message: "expression is false" },
}

const SEARCH_COMMANDS = new Set(Object.keys(SEARCH_COMMAND_EXIT_CODES))

export function interpretCommandExitCode(commandName: string, exitCode: number): string {
  const mapping = SEARCH_COMMAND_EXIT_CODES[commandName]
  if (mapping && exitCode === mapping.code) {
    return mapping.message
  }
  return `exit code ${exitCode}`
}

export function isSearchCommand(commandName: string): boolean {
  return SEARCH_COMMANDS.has(commandName)
}
