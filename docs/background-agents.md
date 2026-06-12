# Background Agents

Monolito V2 runs one automatic background agent — `MemoryAgent` — triggered during the heartbeat timer when the user is inactive. This is an **internal maintenance agent**. The user-facing sub-agent delegation feature (`AgentSpawn`, `delegate_background_task`, etc.) and the entire SkillsAgent system were removed.

## MemoryAgent

Focuses on semantic memory synthesis and organization:
- Runs directly inside the daemon process under a custom silent assistant turn.
- Does not spawn a separate process, worktree, or sub-session.
- Analyzes the recent conversation history to identify user profile, identities, preferences, facts, and tasks.
- Uses `BootWrite` and `WorkspaceMemoryFiling` to save relevant information directly into the Memory Palace (`BOOT_WINGS`, `palace_nodes`, and `memory_drawers`).
- Is **100% silent**, writing only notes to the session's worklog (`MemoryAgent executed silently: CONSOLIDATION_OK`) and never adding messages to the thread or sending notifications to the user. This ensures a clean and undisturbed user experience.

The SkillsAgent and entire dynamic skill system (`CreateSkill`, `ListSkills`, `skill_view`, etc.) have been removed. Only `MemoryAgent` remains as the background maintenance agent.
