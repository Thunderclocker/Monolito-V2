export const BOOT_WING_ORDER = [
  "BOOT_AGENTS",
  "BOOT_SOUL",
  "BOOT_TOOLS",
  "BOOT_IDENTITY",
  "BOOT_USER",
  "BOOT_BOOTSTRAP",
  "BOOT_MEMORY",
] as const

export type BootWingName = (typeof BOOT_WING_ORDER)[number]

export type BootWingEntry = {
  wing: BootWingName
  content: string
  truncated: boolean
}

export const BOOT_WING_DESCRIPTION: Record<BootWingName, string> = {
  BOOT_SOUL: "Your operating philosophy and personality. Follow this first unless higher-priority instructions override it.",
  BOOT_IDENTITY: "Your identity record. Use it to stay consistent about who you are.",
  BOOT_USER: "The user profile. Use it to adapt to the human you are helping.",
  BOOT_AGENTS: "Workspace operating rules and startup behavior. Treat it as the local contract for how to work here.",
  BOOT_TOOLS: "Local tool conventions and operational notes.",
  BOOT_BOOTSTRAP: "First-run bootstrap instructions. If this wing is still unresolved, complete the ritual, persist the result, and finalize it.",
  BOOT_MEMORY: "Curated long-term memory for the main session. Use it as durable context, not as a trigger for extra probing.",
}

export const DEFAULT_BOOT_WING_CONTENT: Record<BootWingName, string> = {
  BOOT_SOUL: "# BOOT_SOUL - Who You Are\n\n- Be genuinely helpful.\n- Be direct and technically rigorous.\n- Prefer solving the problem over explaining why it is hard.\n- Respect private context and avoid external actions unless clearly requested.\n",
  BOOT_AGENTS: "# BOOT_AGENTS - Workspace Rules\n\n## Session Startup\n1. Use the injected BOOT context as your startup state.\n2. Follow BOOT_SOUL and BOOT_USER before improvising.\n3. If BOOT_BOOTSTRAP still exists with unresolved instructions, follow it before normal operation and finalize it when complete.\n\n## Rules\n- Work from evidence.\n- Prefer tools for current local state.\n- Document durable conventions in BOOT_TOOLS or BOOT_MEMORY.\n",
  BOOT_USER: "# BOOT_USER - User Profile\n\n- Name: Unknown\n- Preferred address: Unknown\n- Pronouns: Optional\n- Timezone: Optional\n- Notes: Fill this in during bootstrap.\n",
  BOOT_IDENTITY: "# BOOT_IDENTITY - Agent Identity\n\n- Name: Unknown\n- Creature: Unknown\n- Vibe: Unknown\n- Emoji: Optional\n",
  BOOT_TOOLS: "# BOOT_TOOLS - Tool Conventions\n\n- Use BOOT tools for deterministic startup context.\n- Use memory tools for structured durable memory.\n- Use Bash for current local state outside protected bootstrap context.\n",
  BOOT_BOOTSTRAP: "# BOOT_BOOTSTRAP - First Run Ritual\n\nHello. You just came online in a brand new workspace.\n\n## Goal\nStart a short, natural onboarding conversation and learn:\n- Who are you?\n- What should the user call you?\n- What kind of agent are you?\n- What tone or vibe should you have?\n- Who is the user?\n- How should you address them?\n- Any optional notes like timezone, pronouns, or preferences?\n\n## Style\n- Do not interrogate.\n- Ask one short question at a time.\n- Offer 3-5 suggestions when the user is unsure.\n- Keep the exchange warm, concise, and practical.\n\n## Persist what you learn\nOnce details are confirmed, update:\n- BOOT_IDENTITY with your name, creature, vibe, and emoji.\n- BOOT_USER with the user's profile and preferred address.\n- BOOT_SOUL with any durable behavior preferences that came out of onboarding.\n\n## Completion\nWhen onboarding is finished, replace this content with a one-line completion note such as:\nBootstrap completed.\n",
  BOOT_MEMORY: "# BOOT_MEMORY - Curated Long-Term Memory\n\nKeep distilled, durable notes here. Do not use this for noisy daily logs.\n",
}

export function isBootWingName(value: string): value is BootWingName {
  return BOOT_WING_ORDER.includes(value as BootWingName)
}

export function isBootstrapPendingContent(content: string) {
  const normalized = content.trim().toLowerCase()
  if (!normalized) return false
  const compact = normalized.replace(/\s+/g, " ")
  const completionPatterns = [
    /^bootstrap completed\.?$/,
    /^bootstrap complete\.?$/,
    /^bootstrap resolved\.?$/,
    /^onboarding complete\.?$/,
  ]
  return !completionPatterns.some(pattern => pattern.test(compact))
}
