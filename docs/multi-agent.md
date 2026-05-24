# Multi-Agent

Monolito can delegate tasks to profile-scoped sub-agents that run in parallel with the main session.

## Model

Delegated agents run as separate sub-sessions. They do not automatically share the main conversation, so the prompt sent to them must be self-contained.

When isolation is enabled, each delegated worker gets its own Git Worktree created from the main repository state.

Each delegated task has:

- an `agentId`
- a task type
- a target profile
- its own sub-session
- an optional isolated `cwd`
- task notifications back to the parent session

## Agent types

Supported delegation types are:

- `worker`
- `researcher`
- `verifier`

These are orchestration roles, not different runtimes.

## Core actions

The tool harness exposes:

- `AgentSpawn`
- `AgentSendMessage`
- `AgentStop`
- `AgentList`
- `ProfileCreate`

Typical flow:

1. Spawn an agent with a concrete mission.
2. Wait for a task notification before claiming results.
3. Send a follow-up message if the worker should continue or correct course.
4. Stop it if requirements changed or it went off-track.

## Filesystem isolation

Worker isolation is implemented in `src/core/context/gitContext.ts` and `src/core/runtime/orchestrator.ts`.

When `AgentSpawn` is called with `isolation: "worktree"`:

1. Monolito creates a temporary branch such as `monolito-worker-<uuid>`.
2. It creates a Git Worktree under `~/.monolito-v2/run/worktrees/`.
3. The worker turn runs with that worktree as its effective `cwd`.
4. The parent workspace remains untouched by direct worker writes.
5. When the worker completes, fails, or is stopped, the worktree is removed.

This gives real disk isolation, not just logical session isolation.

The practical consequence is important: a worker can edit files in parallel without colliding with the coordinator's root directory, and the temporary branch/worktree is destroyed after the `<task-notification>` lifecycle closes.

## Profiles

Delegation runs against profiles, not just anonymous tasks.

A profile has its own:

- identity
- workspace files
- memory scope

That lets Monolito create specialized agents without merging all personas into the main session.

The temporal knowledge graph and Memory Palace are also profile-scoped unless explicitly filed into a shared wing.

## Telegram behavior

If an agent is spawned from a Telegram-backed session, completion or failure summaries can be mirrored back to the originating chat.

## Background Memory Consolidation & Skill Synthesis

Monolito V2 features two automatic, background agents triggered consecutively during the active heartbeat timer when the user is inactive:

### 1. MemoryAgent
Focuses on semantic memory synthesis and organization:
- Runs directly inside the daemon process under a custom silent assistant turn.
- Does not spawn a separate Git worktree or poll for user messages.
- Analyzes the recent conversation history to identify user profile, identities, preferences, facts, and tasks.
- Uses `BootWrite` and `WorkspaceMemoryFiling` to save relevant information directly into the Memory Palace (`BOOT_WINGS`, `palace_nodes`, and `memory_drawers`).
- Is **100% silent**, writing only notes to the session's worklog (`MemoryAgent executed silently: CONSOLIDATION_OK`) and never adding messages to the thread or sending notifications to the user. This ensures a clean and undisturbed user experience.

### 2. SkillsAgent
Focuses on technical automation, scripting, and complete skill lifecycle management:
- Runs immediately after `MemoryAgent` during the heartbeat check under a silent assistant turn.
- Lists and analyzes all existing dynamic skills via `ListSkills` to understand the current library.
- Analyzes the technical terminal command logs, execution history, and tool outputs in this session to identify repetitive tasks.
- **Synthesizes & Creates** robust dynamic skills (Bash scripts) using the `CreateSkill` tool.
- **Merges & Consolidates** redundant, overlapping, or narrow near-duplicate skills under a single, well-structured "umbrella" skill to prevent catalog inflation.
- **Updates** existing skills using `CreateSkill` to adjust parameters, fix errors, or adapt them to new project paradigms (e.g. `npm` to `pnpm` migration).
- **Archives & Deletes** obsolete or failing skills via `DeleteSkill` to keep the vector search pre-filtering clean and optimized.
- Is **100% silent**, recording its outcome to the worklog (`SkillsAgent executed silently: SKILLS_OK`).
