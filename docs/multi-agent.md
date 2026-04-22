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
