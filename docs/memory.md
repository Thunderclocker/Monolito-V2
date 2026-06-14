# Memory system

Monolito stores **all** durable state as files under `$MONOLITO_ROOT/memory/`.
There is no SQLite database and no embedding service.

| Layer | Path | Purpose |
|-------|------|---------|
| BOOT wings | `boot/*.md`, `memory.md` | Identity + curated long-term digest (full-loaded each turn) |
| Sessions | `sessions/<id>/*.jsonl` | Messages, worklog, events |
| Config | `config/CONF_*.json` | Runtime configuration wings |
| State | `state/*.json`, `state/*.jsonl` | Graph, ralph rules, semantic tools, telegram queue, cursors |
| Profiles | `profiles.json` | Profile registry |

See [`memory-files-redesign.md`](./memory-files-redesign.md) for the full layout.

## Recall

- **BOOT + memory.md**: injected in full on every turn (prompt caching).
- **History**: keyword scan over `sessions/*/messages.jsonl` via `getSemanticMessageContext`.
- **Curated facts**: keyword scan over `memory.md` sections via `recallMemory` / `WorkspaceMemoryRecall`.

No FTS5 tables, no `memory.sqlite`, no Ollama embeddings.

## BOOT wings

Allowed wings (enforced in [`src/core/bootstrap/bootWings.ts`](../src/core/bootstrap/bootWings.ts)):

| Wing | File | Purpose |
|------|------|---------|
| `BOOT_AGENTS` | `boot/agents.md` | Agent rules, delegation |
| `BOOT_SOUL` | `boot/soul.md` | Identity, principles |
| `BOOT_TOOLS` | `boot/tools.md` | Tool usage rules |
| `BOOT_IDENTITY` | `boot/identity.md` | External identity metadata |
| `BOOT_USER` | `boot/user.md` | User profile |
| `BOOT_BOOTSTRAP` | `boot/bootstrap.md` | First-run onboarding |
| `BOOT_MEMORY` | `memory.md` | Long-term curated digest |

Custom `BOOT_*` wings beyond this set are blocked at the tool registry.

### Tools

- `BootRead` / `BootWrite` / `BootListWings` / `BootCreateWing`
- `WorkspaceMemoryFiling` / `WorkspaceMemoryRecall` → sections in `memory.md`
- `SearchHistory` → keyword scan over session JSONL

## Knowledge graph

Temporal triples (`subject`, `predicate`, `object`, validity window) in
`state/knowledge_graph.jsonl`. Tools: graph add/query/invalidate (see
[`src/core/tools/domains/memory.ts`](../src/core/tools/domains/memory.ts)).

## Context engine (long sessions)

Compaction and incremental flush file summarized chunks into `memory.md`
sections and compact message JSONL in place. See [`guards.md`](./guards.md)
and [`architecture.md`](./architecture.md).

## Inspection (no sqlite3)

```bash
# Active session messages (last 5)
tail -5 ~/.monolito/memory/sessions/orchestrator/messages.jsonl

# Config
cat ~/.monolito/memory/config/CONF_CHANNELS.json

# Curated memory
less ~/.monolito/memory/memory.md
```
