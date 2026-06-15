# Bootstrap and Memory Layers

Monolito does not use workspace markdown files (`SOUL.md`, `USER.md`, etc.) for runtime state. Bootstrap and durable memory live under `$MONOLITO_ROOT/memory/` as markdown and JSON/JSONL files.

## Boot context files

`BOOT_*` keys identify deterministic startup context injected at session start. Files live in `memory/boot/*.md` plus the curated digest `memory/memory.md` (`BOOT_MEMORY`).

| Key | File |
|-----|------|
| `BOOT_AGENTS` | `boot/agents.md` |
| `BOOT_SOUL` | `boot/soul.md` |
| `BOOT_TOOLS` | `boot/tools.md` |
| `BOOT_IDENTITY` | `boot/identity.md` |
| `BOOT_USER` | `boot/user.md` |
| `BOOT_BOOTSTRAP` | `boot/bootstrap.md` |
| `BOOT_MEMORY` | `memory.md` |

These files are the first layer of the memory contract and are loaded in full on every turn.

## Memory pyramid

- **Boot files (`memory/boot/*.md`)**: deterministic startup seed, stable identity and user profile.
- **memory.md sections**: curated long-term facts filed via `WorkspaceMemoryFiling` (keyword recall).
- **Temporal knowledge graph**: `state/knowledge_graph.jsonl` — time-aware triples with validity windows.
- **Session JSONL**: messages, worklog, events under `sessions/<id>/`.

Stable profile facts should be persisted into `BOOT_IDENTITY` or `BOOT_USER` via `BootWrite`. Open-ended or time-varying facts go to `memory.md` or the knowledge graph.

## Temporal knowledge graph

Profile-scoped triples in `state/knowledge_graph.jsonl`:

- `subject`, `predicate`, `object`
- `valid_from`, optional `valid_to`

Tools: `KgAdd`, `KgInvalidate`, `KgQuery`.

## Startup behavior

At session startup, Monolito reads boot files in a fixed order. If `BOOT_BOOTSTRAP` is unresolved, onboarding mode runs instead of normal assistance.

## Onboarding

- One short question per turn
- Persist answers into the relevant boot files via `BootWrite`
- Mark bootstrap complete in `BOOT_BOOTSTRAP` when done

## Main session memory

- Boot files + `memory.md` are auto-loaded each turn (prompt caching)
- Graph facts are queried via tools, not injected wholesale
- Keyword recall scans `memory.md` and session message JSONL (no embeddings)

## Legacy workspace files

`SOUL.md`, `USER.md`, `MEMORY.md`, `TOOLS.md` in a workspace are not part of the runtime contract. `AGENTS.md` in this repo is operator documentation only.
