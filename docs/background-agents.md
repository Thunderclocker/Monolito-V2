# Background Agents

Monolito V2 runs two automatic, background agents — `MemoryAgent` and `SkillsAgent` — triggered consecutively during the heartbeat timer when the user is inactive. These are **internal maintenance agents**, not user-facing delegation. The user-facing sub-agent delegation feature (`AgentSpawn`, `delegate_background_task`, etc.) was removed in migration `20260611_drop_worker_tables.sql`.

The two surviving background agents run as silent in-process turns under a synthetic session ID, never as separate workers, and never communicate with the end user.

## MemoryAgent

Focuses on semantic memory synthesis and organization:
- Runs directly inside the daemon process under a custom silent assistant turn.
- Does not spawn a separate process, worktree, or sub-session.
- Analyzes the recent conversation history to identify user profile, identities, preferences, facts, and tasks.
- Uses `BootWrite` and `WorkspaceMemoryFiling` to save relevant information directly into the Memory Palace (`BOOT_WINGS`, `palace_nodes`, and `memory_drawers`).
- Is **100% silent**, writing only notes to the session's worklog (`MemoryAgent executed silently: CONSOLIDATION_OK`) and never adding messages to the thread or sending notifications to the user. This ensures a clean and undisturbed user experience.

## SkillsAgent

Focuses on technical automation, scripting, and complete skill lifecycle management:
- Runs immediately after `MemoryAgent` during the heartbeat check under a silent assistant turn.
- Lists and analyzes all existing dynamic skills via `ListSkills` to understand the current library.
- Analyzes the technical terminal command logs, execution history, and tool outputs in this session to identify repetitive tasks.
- **Synthesizes & Creates** robust dynamic skills (Bash scripts) using the `CreateSkill` tool.
- **Merges & Consolidates** redundant, overlapping, or narrow near-duplicate skills under a single, well-structured "umbrella" skill to prevent catalog inflation.
- **Updates** existing skills using `CreateSkill` to adjust parameters, fix errors, or adapt them to new project paradigms (e.g. `npm` to `pnpm` migration).
- **Archives & Deletes** obsolete or failing skills via `DeleteSkill` to keep the vector search pre-filtering clean and optimized.
- Is **100% silent**, recording its outcome to the worklog (`SkillsAgent executed silently: SKILLS_OK`).
