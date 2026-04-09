# Tool Harness

Monolito does not rely on free-form shell instructions alone. It exposes a structured tool registry and applies permission checks before execution.

## Purpose

The tool harness gives the model controlled access to workspace actions while preserving:

- structured inputs and outputs
- runtime logging
- permission gating
- better UI rendering for tool activity

## Major tool groups

The registry includes tools for:

- shell execution
- workspace file read/write
- core file read/write
- Memory Palace filing and recall
- MCP listing, reading, and tool calls
- Telegram send and file handling
- task tracking
- agent orchestration

## Shell execution

Shell commands run through a dedicated tool instead of raw assistant prose.

Important constraints:

- permission mode can deny unsafe commands
- obviously destructive commands are blocked unless explicitly allowed by policy
- long-running commands can run in background mode
- tool events are rendered back into the session transcript

## Protected workspace context

Monolito distinguishes between:

- general workspace files
- injected core files

Core files like `SOUL.md`, `USER.md`, and `MEMORY.md` have dedicated read/write tools so the model can update durable persona and memory state without relying on arbitrary file paths.

## Memory tools

The memory tools use a SQLite-backed “Memory Palace” structure with:

- `wing`
- `room`
- optional `key`
- content

Recall supports both structural filtering and semantic lookup.

## MCP

Monolito can connect to stdio MCP servers and expose:

- tool listing
- resource listing
- resource reads
- remote MCP tool calls

## Observability

Tool starts, completions, failures, and summaries are appended to runtime events and the session worklog.
