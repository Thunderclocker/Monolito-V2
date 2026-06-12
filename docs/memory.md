# Memory system

Monolito V2 has a three-layer memory architecture, plus a vector search
backend, plus a recovery engine for long sessions. This document is the
map of all five.

| Layer | Storage | Purpose | Mutability |
|-------|---------|---------|------------|
| 1. BOOT wings | `palace_nodes` (`BOOT_WING` namespace) | Deterministic bootstrap state | Mutable, versioned |
| 2. Memory Palace | `palace_nodes` (other namespaces) | Durable episodic + thematic context | Mutable, versioned |
| 3. Knowledge graph | `graph_triples` | Time-scoped relations | Append + invalidate |
| 4. Embeddings | `vec_drawers`, `vec_messages` (sqlite-vec) | Semantic recall | Append-only, regenerable |
| 5. Context Engine | in-memory + DB rewrite | Anti-amnesia for long sessions | Compresses in place |

All five share one SQLite database at
`$MONOLITO_ROOT/memory/memory.sqlite`.

The full schema is defined in
[`src/core/db/schema.ts`](../src/core/db/schema.ts).

---

## 1. BOOT wings

BOOT wings are the deterministic identity and rule set of the runtime.
They live in the `BOOT_WING` namespace of `palace_nodes` and are the
first thing the model sees on every turn.

Allowed wings (enforced at the tool registry layer — see
[`src/core/bootstrap/bootWings.ts`](../src/core/bootstrap/bootWings.ts)):

| Wing             | Purpose                                              |
|------------------|------------------------------------------------------|
| `BOOT_AGENTS`    | Agent profiles, capabilities, delegation rules       |
| `BOOT_SOUL`      | Identity, purpose, principles                        |
| `BOOT_TOOLS`     | Tool usage rules, custom procedure reminders         |
| `BOOT_IDENTITY`  | Visual / external identity metadata                  |
| `BOOT_USER`      | User profile (preferences, identity, language)      |
| `BOOT_BOOTSTRAP` | First-run onboarding state                           |
| `BOOT_MEMORY`    | Index of what is in the Palace (consolidated memory) |

Custom wings (`BOOT_PERSONALITY`, `BOOT_AI_NAME`, etc.) are **strictly
blocked**. The tool registry refuses to write them. The reason is
operational: keeping the wings enumerated prevents the agent from
fabricating its own identity.

### Single-user architecture

BOOT wings are seeded exclusively under the `default` profile. Other
profiles (`Amanda`, `coder`, `coordinator`, anything created via
`ProfileCreate`) transparently inherit the same rows via a `__global__`
fallback lookup. This prevents the runtime from accumulating duplicate
identity rows when the user creates a new profile.

See [`single-user-boot.md`](./single-user-boot.md) for the full design
rationale.

### Read / write

- `BootRead(wing, profileId?)`
- `BootListWings(profileId?)`
- `BootCreateWing(wing)` — alphanumeric/snake_case, must start with a
  letter. Blocked for the 7 reserved names unless using the bootstrap
  initializer.
- `BootWrite(wing, content, action="overwrite"|"append")` — append keeps
  history; overwrite replaces the latest row.

Use `BOOT_USER` and `BOOT_SOUL` carefully. Changes affect every
profile.

---

## 2. Memory Palace

The Memory Palace is the larger, more flexible memory store. It is
keyed by `(namespace, wing, room, node_key, profile_scope)` with
`mutable=1` and a `superseded_at` column for history.

| Namespace        | Use case                                                |
|------------------|---------------------------------------------------------|
| `BOOT_WING`      | BOOT wings (above)                                      |
| `CONFIG_WING`    | `CONF_*` runtime configuration (channels, models, etc.) |
| `chat_history`   | Verbatim conversation turns (semantic recall)           |
| `identity`       | Per-profile identity facts                              |
| `project_facts`  | Project-scoped knowledge                                |

Any other namespace is also allowed. Tools like `WorkspaceMemoryFiling`
use custom namespaces for ad-hoc storage.

### Wing conventions

- `SHARED` is a special wing visible to **all** profiles. Use it for
  team-wide memory or runtime-wide constants.
- `active_tasks` is the wing where `TodoWrite` / `TodoList` /
  `TodoUpdate` persist task state. It is the data source for the
  Ralph Loop's unfinished-task check.
- `websearch_history` is the wing where `WebSearch` results are
  cached per session.

### Mutable nodes

`palace_nodes` supports `mutable=1` with a unique partial index:

```sql
CREATE UNIQUE INDEX idx_palace_nodes_active_mutable
  ON palace_nodes(namespace, wing, room, node_key, profile_scope)
  WHERE mutable = 1 AND superseded_at IS NULL AND node_key IS NOT NULL;
```

When a new value is written for a mutable node, the previous row is
`superseded_at`-stamped rather than deleted, preserving history.

### Read / write

- `WorkspaceMemoryFiling(wing, room, key?, content, contentType, profileId?)`
- `WorkspaceMemoryRecall(wing?, room?, key?, query?, profileId?, limit?)`
- Recall returns both the active row and any superseded rows; filter
  by `superseded_at IS NULL` if you only want the current value.

---

## 3. Knowledge graph

A small but important third layer. Stored in `graph_triples`:

```sql
CREATE TABLE graph_triples (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  subject TEXT,
  predicate TEXT,
  object TEXT,
  valid_from TEXT,
  valid_to TEXT,        -- NULL = active
  created_at TEXT,
  is_active INTEGER
);
```

The graph stores **time-scoped facts** like:

- `(Magdalena, trabaja_en, Casino Santa Fe, valid_from=2024-01-01)`
- `(Ainelen, vive_con, Cristian, valid_from=2023-06-01)`
- `(PC, tiene_GPU, RTX 3060 12GB, valid_from=2025-01-01)`

When a fact changes (job change, new GPU), the old triple is
`valid_to`-stamped and a new one is added. `KgQuery` returns only
active triples within the queried window.

### Tools

- `KgAdd(subject, predicate, object, validFrom, validTo?)`
- `KgInvalidate(tripleId, validTo)`
- `KgQuery(entity, predicate?, asOf?)`

The graph is **append-only with explicit invalidation**. MemoryAgent
uses it to record durable facts without polluting the Palace with
high-cardinality rows.

---

## 4. Embeddings

The vector layer powers semantic recall. Two sqlite-vec virtual tables
back it:

```sql
CREATE VIRTUAL TABLE vec_drawers USING vec0(
  id INTEGER PRIMARY KEY,
  embedding float[1024]
);

CREATE VIRTUAL TABLE vec_messages USING vec0(
  id INTEGER PRIMARY KEY,
  embedding float[1024]
);
```

Vectors are 1024-dimensional, produced by Ollama running
`bge-m3` in the `monolito-v2-ollama-embeddings` container.

### Lifecycle

1. **Startup warmup** — `initEmbeddingEngine()` in
   [`src/core/session/embeddings.ts`](../src/core/session/embeddings.ts).
   Probes Ollama, deploys the container if missing, pulls the model.
   Times out at 30s; falls back to lazy mode.
2. **Write path** — every `appendMessage`, every `palace_nodes` insert,
   goes through `generateEmbedding(text)` which:
   - Computes SHA-256 of the text.
   - Checks `embedding_cache` (LRU, 10k entries) for a hit.
   - Hits Ollama `/api/embeddings` for the vector.
   - Normalizes the vector (unit length) for cosine-similarity.
   - Persists to the appropriate `vec_*` table.
3. **Read path** — `getSemanticMessageContext(rootDir, queryVector, limit)`
   runs KNN over `vec_messages`, joins back to `messages` to fetch the
   text, formats the result for the dynamic context block.
4. **Background sync** — on daemon startup, `syncMissingEmbeddings()`
   scans for `messages` and `palace_nodes` rows that landed while
   Ollama was down and back-fills their embeddings in the background.

### Degraded mode

If Ollama is unavailable, the runtime continues without errors. The
semantic recall path simply returns the last 12 messages linearly
(instead of the 12 most similar). `WorkspaceMemoryRecall` returns the
most recent rows ordered by `updated_at` instead of by similarity.

This is intentional. The runtime is more useful with stale recall
than with no runtime at all.

### Cache

```sql
CREATE TABLE embedding_cache (
  provider TEXT,
  model TEXT,
  hash TEXT,
  embedding TEXT,
  dims INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (provider, model, hash)
);
```

Pruned at 10k entries (oldest first). The hash is SHA-256 of the
normalized text, so identical inputs hit the cache across sessions.

---

## 5. Context Engine

The fifth layer is not a store — it is a recovery engine that prevents
amnesia in long sessions. It runs three cascaded tiers, in order of
expense.

### Capa 1 — Preventive (`toolResultGuard.ts`)

Every `tool` message in the active turn is passed through
`enforceToolResultBudget(text, model)`. The budget is
`min(0.30 × contextWindowTokens, 400_000)` characters.

- If the result fits, pass through unchanged.
- Otherwise, `truncateHeadTail` cuts the middle and keeps the head
  and tail. The tail is preserved when it contains error keywords
  (`error`, `exception`, `failed`, `panic`, `stack trace`, `errno`,
  `exit code`, `stderr`, JSON closing brackets, success markers).
- If the result exceeds 400KB after truncation, the runtime offloads
  the full content to `$MONOLITO_ROOT/scratchpad/<hash>.txt` and
  replaces the in-context text with a head preview + a hint to read
  the file.

This is per-tool, not per-turn. A 200KB tool result does not eat
the whole context.

### Capa 2 — Compaction (`smartCompactor.ts`)

When the total message history exceeds 80% of the budget, the runtime
calls `smartCompactSession(rootDir, sessionId, options)`. The compactor:

1. Identifies **protected zones**:
   - `head` = system messages + first user message + first assistant
     reply.
   - `tail` = last 3 complete user-initiated turns (configurable via
     `protectTailTurns`).
2. Selects the **compressible zone** = everything between head and tail.
3. If the compressible zone is large enough (> 4000 chars), it is
   summarized by a background LLM call (`runBackgroundTextTask`).
4. The summary **rewrites the first message in place** and deletes the
   rest of the compressible messages. The summary text is prefixed with
   `[RESUMEN DE CONTEXTO — N turnos resumidos]`.

The original messages are not preserved. The summary replaces them.
A worklog entry records the compaction.

### Capa 3 — Recovery cascade

If the provider throws `ContextOverflowError`, the runtime:

1. Calls `smartCompactSession(... forceTier2=true)`.
2. Calls `compactInMemoryTier1` to snip old tool results in the active
   turn.
3. Reloads the session state from SQLite.
4. Re-injects the current turn's tool results so the model has the live
   data.
5. Retries the model call.
6. If 3 compactions happen in the same turn, the engine **aborts**:
   - Writes a full JSON trajectory of all messages to
     `$MONOLITO_ROOT/snapshots/<sessionId>-<timestamp>.json`.
   - Surfaces a clear error to the user: *the session has run out of
     context budget after repeated compactions; please start a new
     session or use /compact manually*.

This anti-thrash gate prevents the runtime from compacting itself into
incoherence.

---

## 6. Heartbeat agents (silent background)

When the user is idle for `min_idle_minutes` (default 3, configurable
via `CONF_HEARTBEAT` wing), the inactivity timer fires and runs the
MemoryAgent. It uses a **cursor-based checkpoint** to process only
messages not yet consolidated, avoiding re-processing and duplication.
Result stats are emitted as visible events to the CLI (but not to
Telegram or audio).

Configuration: `CONF_HEARTBEAT` wing with `enabled`, `min_idle_minutes`,
`interval_minutes`.

### MemoryAgent

Scope: **memory consolidation**. Reads new messages since last checkpoint,
reasons about what matters, and files durable facts with dedup:

- Identity facts → `BootWrite` `BOOT_USER` / `BOOT_IDENTITY`
- Behavioral rules → `BootWrite` `BOOT_SOUL`
- Project facts, decisions, tasks → `WorkspaceMemoryFiling` with descriptive `memory_key`
- The storage layer (`upsertMemoryDrawer`) deduplicates: same key + same content → skip, same key + different content → update, new key → insert.

**Forbidden:** writing absolute or non-overridable memory constraints
(commit `ebf9b6f`). MemoryAgent must not synthesize rules that would
override Level 0 user intent.

The SkillsAgent and entire dynamic skill system have been removed (June 2026). Only MemoryAgent remains for background memory consolidation.

---

## 7. Operational view

```bash
# Inspect all BOOT wings for a profile
sqlite3 ~/.monolito/memory/memory.sqlite \
  "SELECT wing, length(content), updated_at FROM palace_nodes
   WHERE namespace = 'BOOT_WING' AND superseded_at IS NULL
   ORDER BY wing"

# Count Palace facts per wing
sqlite3 ~/.monolito/memory/memory.sqlite \
  "SELECT wing, COUNT(*) FROM palace_nodes
   WHERE superseded_at IS NULL GROUP BY wing ORDER BY 2 DESC"

# Inspect the knowledge graph
sqlite3 ~/.monolito/memory/memory.sqlite \
  "SELECT subject, predicate, object, valid_from, valid_to
   FROM graph_triples ORDER BY created_at DESC LIMIT 50"

# Vector table health
sqlite3 ~/.monolito/memory/memory.sqlite \
  "SELECT 'vec_messages' AS t, COUNT(*) AS n FROM vec_messages
   UNION ALL SELECT 'vec_drawers', COUNT(*) FROM vec_drawers"
```

Or use the in-app `SessionForensics` tool, which is the supported
interface.
