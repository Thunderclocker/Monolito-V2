# Memory Agent

The background `Memory Agent` reviews recent conversation after the main reply is already sent and decides whether something should be persisted for future turns.

This document describes the current runtime behavior. It replaces older descriptions that treated `BOOT_*` as the only durable memory target.

## Purpose

The memory system now has three distinct layers:

- `BOOT_*`: deterministic bootstrap state and persona scaffolding
- canonical structured memory: stable assistant/user profile facts
- Memory Palace: broader long-term contextual memory

The `Memory Agent` is responsible for conservative, post-turn persistence without interrupting the chat.

## Triggers

The `Memory Agent` runs in the background at these moments:

- after normal turns (`post-turn`)
- before `/compact` rewrites older session history (`pre-compact`)
- before session resets such as `/new` (`session-end`)

## Memory layers

### Bootstrap wings

`BOOT_*` wings are SQLite-backed bootstrap records, not free-form workspace files.

Important ones for memory behavior:

- `BOOT_IDENTITY`: deterministic bootstrap identity seed
- `BOOT_USER`: deterministic bootstrap user/profile seed
- `BOOT_MEMORY`: curated long-term context visible in the main session prompt

These are still read by the runtime, but they are no longer the only place where stable facts can live.

### Canonical structured memory

Canonical memory stores stable facts in structured slots inside `memory_drawers`.

Current slots:

- `assistant_name`
- `user_name`
- `user_preferred_name`
- `user_location`
- `user_timezone`

This layer is now the primary source of truth for stable assistant identity and stable user profile facts.

Examples:

- the assistant's confirmed name
- the user's preferred way of being addressed
- the user's city/location
- the user's timezone

The runtime prefers canonical memory over stale `BOOT_*` fields when they conflict.

### Memory Palace

Memory Palace is the broader SQLite-backed long-term memory system used for contextual recall.

It stores:

- `wing`
- `room`
- optional `key`
- `content`

Use it for:

- ongoing projects
- medium-term plans
- recurring interaction patterns
- contextual facts worth recalling later

## Current routing behavior

The `Memory Agent` model still proposes one of these destinations:

- `USER`
- `MEMORY`
- `MEMPALACE`

Current runtime behavior after a proposal:

1. `USER` writes to `BOOT_USER`
2. `MEMORY` writes to `BOOT_MEMORY`
3. `MEMPALACE` files into Memory Palace
4. the runtime also inspects proposal text and promotes stable profile facts into canonical structured memory when detected

That promotion step is important. It fixes a class of historical bugs where facts like assistant name or user location were captured in `BOOT_MEMORY` but later not found when the agent looked for canonical profile data.

## Routing guidelines

Use these semantics when thinking about where information belongs:

- stable assistant/user profile fact: canonical structured memory first
- deterministic bootstrap seed or onboarding scaffold: `BOOT_*`
- durable relational or long-running context: `BOOT_MEMORY`
- useful but less canonical context: Memory Palace
- trivial or low-value context: do not save it

Examples:

- `"Amanda"` as the assistant's confirmed name: canonical memory
- `"Cristian vive en Santo Tomé, Santa Fe"`: canonical memory
- `"Cristian prefiere explicaciones simples y directas"`: `BOOT_MEMORY` or `BOOT_USER` depending on whether it is a user-profile preference vs interaction pattern
- `"investigación sobre clima pendiente"`: Memory Palace or `BOOT_MEMORY` depending on durability

## Contradictions and replacement

If new information clearly updates an older stable fact, prefer replacement over accumulation.

Examples:

- user location changed
- assistant name was finally confirmed
- preferred user name was clarified

When contradiction is weak or uncertain:

- prefer Memory Palace
- or save nothing

## Embeddings and semantic lookup

Memory Palace recall supports semantic lookup through local embeddings.

Current runtime behavior:

- embeddings use a local `@xenova/transformers` model
- the daemon attempts a non-blocking background warmup on startup
- if warmup fails, Monolito continues in lazy mode
- filing can still succeed without vectors
- semantic recall falls back to non-semantic recent memory when embeddings are unavailable

This means embeddings improve recall quality, but they are not a hard startup dependency.

## Logging

The `Memory Agent` uses the normal daemon logger category `memory-agent`.

In practice, operational logs are typically observed in:

- `~/.monolito-v2/logs/monolitod.log`

Typical events include:

- `review.start`
- `review.model_response`
- `proposal.applied`
- `proposal.skip`
- `review.done`
- `review.noop`

If the agent applies a change, Monolito also appends a summary to session worklog.
