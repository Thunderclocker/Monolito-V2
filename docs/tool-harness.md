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
- BOOT wing read/write
- curated memory filing and recall (`WorkspaceMemoryFiling` / `WorkspaceMemoryRecall`)
- temporal knowledge graph reads and writes
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
- injected BOOT wings

Deterministic BOOT wings like `BOOT_SOUL`, `BOOT_IDENTITY`, `BOOT_USER`, and `BOOT_MEMORY` have dedicated read/write tools so the model can update bootstrap state, identity, and user profile facts without relying on arbitrary file paths or legacy workspace files.

## Memory tools

Memory is file-backed:

- BOOT wings: `memory/boot/*.md` via `BootRead` / `BootWrite`
- Curated facts: `memory/memory.md` sections via `WorkspaceMemoryFiling` / `WorkspaceMemoryRecall`
- Session history: `sessions/<id>/messages.jsonl` via `SearchHistory` and keyword recall

Recall uses keyword matching over markdown sections and message JSONL (no embeddings).

## Knowledge graph tools

Temporal triples in `state/knowledge_graph.jsonl`:

- `KgAdd`
- `KgInvalidate`
- `KgQuery`

`KgAdd` schema:

- `subject`
- `predicate`
- `object`
- optional `valid_from`

`KgInvalidate` schema:

- `subject`
- `predicate`
- `object`
- optional `valid_to`

`KgQuery` schema:

- `entity`

Behavior:

- `KgAdd` inserts a profile-scoped triple into `knowledge_graph`
- `KgInvalidate` sets `valid_to` on matching active triples
- `KgQuery` returns triples where the entity appears as `subject` or `object`, including whether each fact is still active

Use these tools for time-aware facts that should not be flattened into free-form `memory.md` text.

## BOOT vs graph vs curated memory

Use the layers differently:

- BOOT tools: bootstrap seed, onboarding, identity, stable user profile, and system instructions
- graph tools: time-aware relations and facts with lifecycle
- curated memory tools: durable facts in `memory.md`, keyword recall, and session history search

## MCP

Monolito can connect to stdio MCP servers and expose:

- tool listing
- resource listing
- resource reads
- remote MCP tool calls

## Observability

Tool starts, completions, failures, and summaries are appended to runtime events and the session worklog.
