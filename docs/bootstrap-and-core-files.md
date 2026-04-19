# Bootstrap and Memory Layers

Monolito no longer depends on literal workspace files like `SOUL.md` or `USER.md` for startup. Bootstrap state lives in SQLite-backed `BOOT_*` wings, and durable profile facts now also have a separate canonical memory layer.

## What BOOT Still Does

`BOOT_*` is the deterministic seed injected at session start. It is loaded structurally from `memory_drawers`, not from legacy markdown files.

Current BOOT wings:

- `BOOT_AGENTS`
- `BOOT_SOUL`
- `BOOT_TOOLS`
- `BOOT_IDENTITY`
- `BOOT_USER`
- `BOOT_BOOTSTRAP`
- `BOOT_MEMORY`

These wings are still important, but they are no longer the whole memory contract.

## What Changed

Monolito now uses three distinct memory layers:

- `BOOT_*`: deterministic startup seed and stable system bootstrap.
- Canonical memory: structured durable facts such as assistant name and stable user profile fields.
- Memory Palace: flexible long-lived memory entries and semantic recall.

The practical consequence is that stable profile facts should not rely only on `BOOT_IDENTITY` or `BOOT_USER`. The runtime now prefers canonical memory for those facts and falls back to legacy BOOT content when needed.

## Canonical Memory

Canonical memory is stored in SQLite and currently tracks stable slots such as:

- `assistant_name`
- `user_name`
- `user_preferred_name`
- `user_location`
- `user_timezone`

The main assistant can read and write these facts explicitly through `CanonicalMemoryRead` and `CanonicalMemoryWrite`.

The background memory reviewer can also promote facts into canonical memory after a turn, so information confirmed in conversation does not depend on the old BOOT-only routing.

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
- bootstrap content is capped so it does not explode the prompt

## Legacy Files

Legacy files such as `SOUL.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`, and `TOOLS.md` are no longer part of the runtime contract. If they still exist in the workspace, they are historical references only and do not drive runtime persistence.
