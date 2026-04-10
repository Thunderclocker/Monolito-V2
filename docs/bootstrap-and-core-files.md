# Bootstrap and BOOT Wings

Monolito now uses a deterministic SQLite bootstrap contract. Instead of relying on physical workspace files like `SOUL.md` or `USER.md`, startup context is injected from canonical `BOOT_*` wings stored in `memory_drawers`.

## Boot Wings

- `BOOT_AGENTS`
- `BOOT_SOUL`
- `BOOT_TOOLS`
- `BOOT_IDENTITY`
- `BOOT_USER`
- `BOOT_BOOTSTRAP`
- `BOOT_MEMORY`

These wings are loaded structurally, not semantically. Bootstrap never depends on `sqlite-vec` or similarity search.

## Startup behavior

At session startup, Monolito reads the current profile's BOOT wings from SQLite in a fixed order. The same content is injected every time for the same stored state.

If `BOOT_BOOTSTRAP` is still unresolved, Monolito enters onboarding mode instead of normal long-form assistance.

## Onboarding

The onboarding ritual should:

- ask one short question at a time
- persist confirmed details into the appropriate BOOT wings
- replace `BOOT_BOOTSTRAP` with a completion note when onboarding is complete

## Main session memory

- main sessions can auto-load `BOOT_MEMORY`
- sub-agents do not auto-load `BOOT_MEMORY` unless explicitly given it
- bootstrap content is capped so it does not explode the prompt

## Legacy files

Legacy files such as `SOUL.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`, and `TOOLS.md` are no longer part of the runtime contract. If they still exist in the workspace, they have no functional effect on bootstrap or memory persistence.
