export type CliArgs = {
  command?: string
  rest: string[]
  prompt?: string
}

export function parseArgs(argv: string[]): CliArgs {
  const args = [...argv]
  let prompt: string | undefined
  const index = args.findIndex(arg => arg === "-p" || arg === "--print")
  if (index !== -1) {
    prompt = args[index + 1]
    args.splice(index, 2)
  }
  return { command: args[0], rest: args.slice(1), prompt }
}
