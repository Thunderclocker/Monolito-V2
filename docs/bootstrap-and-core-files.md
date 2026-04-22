# Bootstrap and Memory Layers

Monolito no longer depends on literal workspace files like `SOUL.md`, `MEMORY.md`, `USER.md`, `TOOLS.md`, or similar files for runtime state. Bootstrap and memory live in SQLite.

## What BOOT Still Does

`BOOT_*` is the deterministic seed injected at session start. It is loaded structurally from SQLite `memory_drawers`, not from workspace markdown files.

Current BOOT wings:

- `BOOT_AGENTS`
- `BOOT_SOUL`
- `BOOT_TOOLS`
- `BOOT_IDENTITY`
- `BOOT_USER`
- `BOOT_BOOTSTRAP`
- `BOOT_MEMORY`

These wings are still important, but they are only the first layer of the memory contract.

## What Changed

Monolito now uses a memory pyramid:

- `BOOT_*`: deterministic startup seed and stable system bootstrap.
- Canonical memory: structured durable facts such as assistant name and stable user profile fields.
- Temporal knowledge graph: time-aware relations and facts with validity windows.
- Memory Palace: verbatim history plus broader long-lived contextual entries.

Stable profile facts should not rely only on `BOOT_IDENTITY` or `BOOT_USER`. The runtime now prefers canonical memory for those facts and only uses BOOT as deterministic startup scaffolding.

## Canonical Memory

Canonical memory is stored in SQLite and currently tracks stable slots such as:

- `assistant_name`
- `user_name`
- `user_preferred_name`
- `user_location`
- `user_timezone`

The main assistant can read and write these facts explicitly through `CanonicalMemoryRead` and `CanonicalMemoryWrite`.

The background memory reviewer can also promote facts into canonical memory after a turn, so confirmed information does not depend on BOOT-only routing.

## Temporal Knowledge Graph

The temporal graph is also stored in SQLite and keeps profile-scoped triplets:

- `subject`
- `predicate`
- `object`
- `valid_from`
- optional `valid_to`

Use it for facts that may change over time:

- who is learning what
- which project is active
- when a relationship stopped being valid

This layer complements canonical memory. Canonical slots are for a small fixed set of stable identity facts; the graph is for open-ended time-aware relations.

## Memory Palace

The Memory Palace now lives entirely in SQLite.

It stores:

- `wing`
- `room`
- optional `key`
- `content`

The most important current runtime behavior is verbatim filing of recent turns into `HISTORY / verbatim`. That is the default long-term historical substrate; it is not generated from a synthetic summary markdown file.

## Startup Behavior

At session startup, Monolito reads the current profile's BOOT wings in a fixed order. The prompt may also inject canonical memory so the assistant starts with both:

- deterministic bootstrap instructions
- current stable identity and user profile facts

If `BOOT_BOOTSTRAP` is still unresolved, Monolito enters onboarding mode instead of normal long-form assistance.

## Onboarding

The onboarding flow should:

- ask one short question at a time
- persist bootstrap-critical answers into the relevant `BOOT_*` wings
- write stable profile facts into canonical memory when appropriate
- replace `BOOT_BOOTSTRAP` with a completion note when onboarding is complete

In other words, onboarding still writes BOOT state, but it should not treat BOOT as the only durable profile store.

## Main Session Memory

- main sessions can auto-load `BOOT_MEMORY`
- sub-agents do not auto-load `BOOT_MEMORY` unless explicitly given it
- canonical memory is preferred for assistant identity and stable user facts
- temporal graph facts are queried explicitly through tools, not injected wholesale
- Memory Palace recall is SQLite-backed and can use embeddings when available
- bootstrap content is capped so it does not explode the prompt

## Legacy Files

Legacy memory files such as `SOUL.md`, `USER.md`, `MEMORY.md`, and `TOOLS.md` are not part of the runtime contract. If they still exist in the workspace, they are historical references only and do not drive persistence.

`AGENTS.md` is separate: it can still provide operator instructions to the coding agent in this repository, but it is not Monolito's memory backend.
