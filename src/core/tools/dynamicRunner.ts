import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { DynamicSkill } from "../session/store.ts"

const execFileAsync = promisify(execFile)

export interface DynamicSkillExecutionResult {
  ok: boolean
  output: string
  stderr?: string
}

export async function executeDynamicSkill(
  rootDir: string,
  skill: DynamicSkill,
  input: Record<string, unknown>,
  context: { cwd: string; sessionId?: string }
): Promise<DynamicSkillExecutionResult> {
  if (skill.codeType !== "bash") {
    throw new Error(`Execution for codeType '${skill.codeType}' is not supported yet (Bash only).`)
  }

  // 1. Ensure dynamic skills folder exists in .monolito-v2
  const skillsDir = join(rootDir, ".monolito-v2", "dynamic_skills")
  mkdirSync(skillsDir, { recursive: true })

  // 2. Prepare environment variables from input payload
  const skillEnv: Record<string, string> = {
    ...process.env,
    MONOLITO_CWD: context.cwd,
    MONOLITO_SESSION_ID: context.sessionId || "default",
  }

  for (const [key, value] of Object.entries(input)) {
    const envKey = `ARG_${key.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`
    if (typeof value === "object" && value !== null) {
      skillEnv[envKey] = JSON.stringify(value)
    } else {
      skillEnv[envKey] = String(value ?? "")
    }
  }

  // 3. Create a temporary script file
  const tempScriptName = `skill_${skill.name}_${randomUUID().slice(0, 8)}.sh`
  const tempScriptPath = join(skillsDir, tempScriptName)

  // Inject robust Bash setup
  const scriptContent = `#!/usr/bin/env bash
set -e
cd "\${MONOLITO_CWD}"

# User dynamic code:
${skill.code}
`

  writeFileSync(tempScriptPath, scriptContent, { mode: 0o755 })

  try {
    // 4. Execute script using Bash
    const { stdout, stderr } = await execFileAsync("bash", [tempScriptPath], {
      cwd: context.cwd,
      env: skillEnv,
      timeout: 120_000, // 2-minute hard timeout for dynamic scripts
    })

    return {
      ok: true,
      output: stdout,
      stderr: stderr || undefined,
    }
  } catch (error: any) {
    return {
      ok: false,
      output: error.stdout || "",
      stderr: error.stderr || error.message || "Unknown execution error",
    }
  } finally {
    // 5. Cleanup temporary script file
    try {
      unlinkSync(tempScriptPath)
    } catch {
      // Ignore if already deleted
    }
  }
}
