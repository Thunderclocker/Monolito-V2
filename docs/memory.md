# Memory Architecture (file-only)

Monolito V2 stores all durable memory as markdown and JSON/JSONL under `$MONOLITO_ROOT/memory/`. There is **no SQLite**, no embeddings, and no vector recall.

## Layers

| Layer | Path | Role |
|-------|------|------|
| Boot files | `boot/*.md`, `memory.md` | Identity + curated long-term digest (full-loaded each turn) |
| Curated sections | `memory.md` `##` headings | Durable facts via `WorkspaceMemoryFiling` |
| Config | `config/CONF_*.json` | Runtime configuration blocks |
| Sessions | `sessions/<id>/*.jsonl` | Messages, worklog, events |
| State | `state/*.json` | Active tasks, semantic tool index, etc. |
| Graph | `state/knowledge_graph.jsonl` | Temporal triples |

## Boot context files

Allowed keys (enforced in [`src/core/bootstrap/bootWings.ts`](../src/core/bootstrap/bootWings.ts)):

| Key | File |
|-----|------|
| `BOOT_AGENTS` | `boot/agents.md` |
| `BOOT_SOUL` | `boot/soul.md` |
| `BOOT_TOOLS` | `boot/tools.md` |
| `BOOT_IDENTITY` | `boot/identity.md` |
| `BOOT_USER` | `boot/user.md` |
| `BOOT_BOOTSTRAP` | `boot/bootstrap.md` |
| `BOOT_MEMORY` | `memory.md` |

Custom `BOOT_*` keys beyond this set are blocked at the tool registry.

Tools: `BootRead` / `BootWrite` / `BootListFiles` / `BootCreateFile` (aliases: `BootListWings`, `BootCreateWing`).

## Curated memory (`memory.md`)

Sections are `## Heading` blocks. File via `WorkspaceMemoryFiling` with `namespace` + `section`. Recall via keyword scan with `WorkspaceMemoryRecall`.

## Recall paths

1. **Boot files always loaded** — injected in full each turn.
2. **Keyword recall** — `getSemanticMessageContext` and `recallMemory` scan message JSONL and `memory.md`.

## MemoryAgent

Background consolidation turn (in-process, not a worker). Uses `BootWrite` and `WorkspaceMemoryFiling` to deduplicate and update `memory.md` and boot files.
