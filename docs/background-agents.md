# Background Agents

Monolito V2 runs one automatic background agent — `MemoryAgent` — triggered by an inactivity timer when the user has been idle for `min_idle_minutes` (default 3). The previous SkillsAgent and entire dynamic skill system (`CreateSkill`, `ListSkills`, `skill_view`, etc.) have been removed.

## MemoryAgent

Focuses on semantic memory synthesis and organization:
- Runs directly inside the daemon process under a custom assistant turn.
- Does not spawn a separate process, worktree, or sub-session.
- Uses a **cursor checkpoint** (`palace_nodes` wing `MEMORY_CONSOLIDATION`) to track which messages have already been processed. On each run, only **new messages since the last checkpoint** are analyzed — no re-processing, no duplication.
- Fits the message batch to ~65% of the active model's input budget. If there are more messages than fit, the remainder is left for the next consolidation cycle.
- Loads **existing memory context** via `recallMemory` before prompting the LLM, so the model can detect what's already stored and avoid duplicates.
- Uses `BootWrite` (for identity/soul/user) and `WorkspaceMemoryFiling` (for facts, decisions, tasks) with descriptive `memory_key` values. The storage layer (`upsertMemoryDrawer`) automatically detects:
  - Same key + same content → **skip** (no duplication)
  - Same key + different content → **update** (obsolete info replaced)
  - New key → **insert**
- Emits **visible progress events** to the CLI (`message.received` with `role: "system"`) so the user sees consolidation activity in real time. Does **not** produce audio (bypasses voice mode).
- Records final stats to the worklog (`MemoryAgent: 3 inserts, 1 update, 2 skips`).

The SkillsAgent and entire dynamic skill system (`CreateSkill`, `ListSkills`, `skill_view`, etc.) have been removed. Only `MemoryAgent` remains as the background maintenance agent.
