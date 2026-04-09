# Multi-Agent

Monolito can delegate tasks to profile-scoped sub-agents that run in parallel with the main session.

## Model

Delegated agents run as separate sub-sessions. They do not automatically share the main conversation, so the prompt sent to them must be self-contained.

Each delegated task has:

- an `agentId`
- a task type
- a target profile
- its own sub-session
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

## Profiles

Delegation runs against profiles, not just anonymous tasks.

A profile has its own:

- identity
- workspace files
- memory scope

That lets Monolito create specialized agents without merging all personas into the main session.

## Telegram behavior

If an agent is spawned from a Telegram-backed session, completion or failure summaries can be mirrored back to the originating chat.
