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
- canonical memory read/write
- Memory Palace filing and recall
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
- structured canonical memory

Deterministic BOOT wings like `BOOT_SOUL`, `BOOT_USER`, and `BOOT_MEMORY` have dedicated read/write tools so the model can update bootstrap state without relying on arbitrary file paths or legacy workspace files.

Canonical memory has its own tools:

- `CanonicalMemoryRead`
- `CanonicalMemoryWrite`

These are the preferred tools for stable assistant identity and durable user profile facts such as name, preferred name, location, or timezone.

## Memory tools

The memory tools use a SQLite-backed Memory Palace structure with:

- `wing`
- `room`
- optional `key`
- content

Recall supports both structural filtering and semantic lookup.

Semantic lookup depends on embeddings. Monolito now warms the local embeddings pipeline in the background at daemon startup, but the system does not block boot on that warmup. If embeddings are unavailable:

- filing can still succeed without vectors
- semantic recall falls back to recent non-semantic memory
- the user only sees a warning when the missing embeddings materially affect the requested recall

This means semantic memory is opportunistic, not a hard boot dependency.

## Knowledge graph tools

Monolito also exposes temporal knowledge graph tools backed by SQLite:

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

Use these tools for time-aware facts that should not be flattened into free-form Memory Palace text.

## BOOT vs Canonical vs Graph vs Memory Palace

Use the layers differently:

- BOOT tools: bootstrap seed, onboarding, stable system instructions
- canonical memory tools: durable assistant identity and user profile facts
- graph tools: time-aware relations and facts with lifecycle
- Memory Palace tools: verbatim history, broader durable memory, notes, patterns, and semantic recall

Older docs sometimes described BOOT as the main memory layer. That is no longer accurate for current runtime behavior.

## MCP

Monolito can connect to stdio MCP servers and expose:

- tool listing
- resource listing
- resource reads
- remote MCP tool calls

## Observability

Tool starts, completions, failures, and summaries are appended to runtime events and the session worklog.
