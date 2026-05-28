import type { DynamicSkill } from "../session/store.ts"

export interface DynamicSkillExecutionResult {
  ok: boolean
  output: string
  stderr?: string
}

/**
 * @deprecated Dynamic Bash execution has been deprecated in favor of declarative Markdown SOP guides.
 */
export async function executeDynamicSkill(
  rootDir: string,
  skill: DynamicSkill,
  input: Record<string, unknown>,
  context: { cwd: string; sessionId?: string }
): Promise<DynamicSkillExecutionResult> {
  void rootDir
  void input
  void context
  return {
    ok: false,
    output: `Execution of dynamic skill '${skill.name}' is deprecated. Please use skill_view tool to inspect it.`,
  }
}
