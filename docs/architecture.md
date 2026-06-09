# Architecture

This document maps the runtime end-to-end. It is the canonical map of a Monolito
V2 process: from the binary entry point down to the SQLite row that persists a
single user message. Use it as the entry point for any non-trivial code review,
debugging session, or onboarding of a new agent.

If you only read one architecture doc, read this one. For deep dives, the
companion docs are:

- [`guards.md`](./guards.md) — the four runtime guards
- [`memory.md`](./memory.md) — the three-layer memory system
- [`troubleshooting.md`](./troubleshooting.md) — symptom → diagnosis → fix
- [`single-user-boot.md`](./single-user-boot.md) — why there is only one BOOT

---

## 1. Layered overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  bin/monolito.js          npm bin shim → spawns `node --strip-types …`   │
├──────────────────────────────────────────────────────────────────────────┤
│  src/apps/cli.ts          TUI client. Spawns the daemon if not running,  │
│                            then speaks to it over a Unix socket.        │
├──────────────────────────────────────────────────────────────────────────┤
│  src/apps/daemon.ts       Detached process supervisor. Writes pid, lock,│
│                            and ownership files; respawns on /update.     │
├──────────────────────────────────────────────────────────────────────────┤
│  src/core/runtime/        MonolitoV2Runtime: session + turn + tool loop │
│  ├─ runtime.ts            (3545 lines) — the orchestration engine.     │
│  ├─ modelAdapter.ts       Prompt build, provider recovery, streaming.  │
│  ├─ orchestrator.ts       Multi-agent lifecycle, Ralph Loop enforcement.│
│  ├─ providers/            Anthropic SDK, OpenAI-compat, Ollama, Grok.   │
│  ├─ turnExecutionStack.ts Buffered side-effect tool calls.              │
│  ├─ sideEffectGuard.ts    LLM-driven side-effect approval.              │
│  ├─ veracityGuard.ts      Promised vs. executed mismatch detection.     │
│  └─ coherenceGuard.ts     Profile + memory contradiction detection.     │
├──────────────────────────────────────────────────────────────────────────┤
│  src/core/tools/          Tool registry: 60+ tools, Zod-validated input,│
│  └─ registry.ts           permission tiers, post-tool hooks, redacting. │
├──────────────────────────────────────────────────────────────────────────┤
│  src/core/session/        SQLite persistence layer.                     │
│  ├─ store.ts              All CRUD; transactions; semantic RAG.         │
│  └─ embeddings.ts         Ollama embeddings engine + cache.             │
├──────────────────────────────────────────────────────────────────────────┤
│  src/core/channels/       Telegram ingestion + delivery.                │
│  ├─ channelManager.ts     Lifecycle, menus, slash commands.             │
│  └─ telegramPoller.ts     Long-poll loop, attachment download, STT hook.│
├──────────────────────────────────────────────────────────────────────────┤
│  src/core/context/        Context Engine: head+tail truncation, smart  │
│  └─ toolResultGuard.ts,   compaction, recovery cascade.                 │
│  └─ smartCompactor.ts                                                        │
├──────────────────────────────────────────────────────────────────────────┤
│  src/core/{websearch,stt,vision}/managed.ts                               │
│  └─ managed.ts            Docker lifecycle for each remaining managed    │
│                            service (STT, vision, searxng). TTS no longer │
│                            has a managed backend — it runs against      │
│                            hosted providers (MiniMax, OpenAI).           │
├──────────────────────────────────────────────────────────────────────────┤
│  src/core/db/schema.ts    Palace + vector + background_tasks + workers. │
└──────────────────────────────────────────────────────────────────────────┘
```

Total: **89 TypeScript files, ~19.5k lines**. No build step. Everything runs
through `node --experimental-strip-types`.

---

## 2. IPC surface (daemon ↔ client)

The CLI and the daemon communicate over a Unix domain socket at
`/tmp/monolitod-v2-*.sock`. If the Unix socket cannot be created (sandbox,
network namespace), the daemon falls back to TCP on `127.0.0.1`.

The wire protocol is line-delimited JSON envelopes of three kinds:

- `request` — client → daemon
- `response` — daemon → client (matched by `id`)
- `event` — daemon → client (broadcast, e.g. tool start/finish, message received)

Request types are defined in [`src/core/ipc/protocol.ts`](../src/core/ipc/protocol.ts).
The most important ones:

| Request           | Purpose                                              |
|-------------------|------------------------------------------------------|
| `ping`            | Health check                                         |
| `session.ensure`  | Create or fetch a session by id                      |
| `session.list`    | All sessions                                         |
| `session.subscribe` | Stream events for a session (`*` = all)            |
| `message.send`    | Enqueue a user message                               |
| `session.ask`     | Headless single-shot prompt (used for tests)         |
| `daemon.command`  | Run a slash command (`/status`, `/tts`, …)           |
| `query.*`         | Read-only runtime inspection (cost, stats, doctor)   |
| `query.config`    | Read/write `CONF_*` wings                            |
| `permission.respond` | Resolve a pending `permission.request` event       |
| `daemon.stop`     | Shutdown                                             |

Events are defined alongside the requests and include
`message.received`, `tool.start`, `tool.finish`, `turn.completed`,
`agent.background.completed`, and `permission.request`.

---

## 3. End-to-end flow of a single user turn

This is the most important diagram in the project. The path is identical for
the CLI and for Telegram; the only difference is where the user message enters
the pipeline.

```
                              user message
                                   │
                                   ▼
                   ┌───────────────────────────────┐
                   │  runtime.processMessage()      │
                   │  (or processSessionStartup)    │
                   └───────────────┬───────────────┘
                                   │
                                   ▼
                   ┌───────────────────────────────┐
                   │  bound session + RAG recall   │
                   │  • last 8 messages            │
                   │  • 12 semantically similar    │
                   │    past messages (Ollama)     │
                   │  • 3 semantically similar      │
                   │    Palace facts               │
                   │  (degrades gracefully if      │
                   │   embeddings unavailable)     │
                   └───────────────┬───────────────┘
                                   │
                                   ▼
                   ┌───────────────────────────────┐
                   │  Prompt build (modelAdapter)  │
                   │  • static system block        │
                   │    (cache_control: ephemeral) │
                   │  • BOOT_* wing block (cached) │
                   │  • === DYNAMIC CONTEXT ===    │
                   │    (last turn + RAG)          │
                   └───────────────┬───────────────┘
                                   │
                                   ▼
                   ┌───────────────────────────────┐
                   │  Provider call (streaming)    │
                   │  • Anthropic SDK / OpenAI /   │
                   │    Ollama / xai(-oauth)       │
                   │  • x-grok-conv-id for caching │
                   │  • retry state machine:       │
                   │    429 / 503 / 529 / 401 / 403│
                   │    ContextOverflow bubbles up │
                   └───────────────┬───────────────┘
                                   │
                                   ▼
                   ┌───────────────────────────────┐
                   │  Stream parser:              │
                   │  • text deltas → assistant text│
                   │  • tool_use blocks → TES push │
                   └───────────────┬───────────────┘
                                   │
                                   ▼
                   ┌───────────────────────────────┐
                   │  Turn Execution Stack (TES)   │
                                   │
              ┌──────────────┬──────┴─────┬──────────────┐
              ▼              ▼            ▼              ▼
          sideEffect?     normal tool  normal tool  normal tool
              │              │            │              │
              │              └──────┬─────┴──────────────┘
              │                     │
              │                     ▼
              │         executeTool → permission check
              │                     │
              │                     ▼
              │         appendEvent(tool.start/finish)
              │         recordSuccess(toolName) in TES
              │                     │
              ▼                     │
   ┌──────────────────┐             │
   │ Side-Effect Guard│             │
   │ (LLM eval):      │             │
   │  • BOOT_USER     │             │
   │  • recallMemory  │             │
   │  • executed list │             │
   │  • pending list  │             │
   │  Level 0: user   │             │
   │  bypass gana     │             │
   └────────┬─────────┘             │
            │                       │
       approved                     │
            │                       │
            ▼                       │
   replace placeholder with        │
   real execution result            │
            │                       │
            └───────────┬───────────┘
                        │
                        ▼
                any pending in TES?
                  (loop again)
                        │
                        ▼
        ┌──────────────────────────────────────┐
        │ Ralph Loop finalization checks       │
        │  1. <verified>SUCCESS</verified> tag │
        │  2. no pending TodoWrite tasks      │
        │  3. last Bash exit code == 0         │
        │  4. 5 assertion rules (LLM-driven):  │
        │     send_telegram_photo / _file /    │
        │     _msg / modify_workspace_files /  │
        │     search_web                       │
        │  5. dynamic Ralph rules (semantic)   │
        │     with Level 0 user-bypass         │
        │  on failure: re-prompt with the      │
        │  specific system alert               │
        └────────────────┬─────────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────────┐
        │ Turn Integrity Guard                │
        │ (post-finalization LLM audit):      │
        │  • hasBrokenPromise?                │
        │  • hasFalsifiedExecution?            │
        │ fail-safe = approve                 │
        └────────────────┬─────────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────────┐
        │ Coherence Guard (post-finalization)  │
        │ LLM check: response vs BOOT_USER +   │
        │ Palace memories + recent chat.       │
        │ Reject if contradicts user profile.  │
        │ Also rejects "please run X in your   │
        │ terminal" → must use own tools.      │
        │ fail-safe = approve                 │
        └────────────────┬─────────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────────┐
        │ Persist turn:                        │
        │  • messages                          │
        │  • events (tool.start/finish)        │
        │  • worklog entry                     │
        │  • cost tracker                      │
        │  • embeddings (background)           │
        └────────────────┬─────────────────────┘
                         │
                         ▼
                delivery back to user
            (CLI: TUI render | Telegram: sendMessage)
                         │
                         ▼
        ┌──────────────────────────────────────┐
        │ Heartbeat tick (only when user idle) │
        │  • MemoryAgent  (silent Palace write)│
        │  • SkillsAgent  (silent SOP write)   │
        │  Conf: CONF_HEARTBEAT wing           │
        └──────────────────────────────────────┘
```

If at any point the provider throws `ContextOverflowError`, the recovery
cascade fires (see [`memory.md`](./memory.md#context-engine)):

1. Tier 2 LLM compaction of the middle zone of the session
2. Tier 1 in-memory snip of old tool results
3. Reload session state, re-inject the active turn's tool results
4. Retry
5. If 3+ compactions in the same turn: abort, dump full trajectory to
   `snapshots/` under `MONOLITO_ROOT`, surface a clear error to the user.

---

## 4. Persistence

Everything stateful lives in **one SQLite database** at
`$MONOLITO_ROOT/memory/memory.sqlite`, plus a small set of sibling directories
under `$MONOLITO_ROOT`.

```
~/.monolito/
├── .env                       # bootstrap configuration
├── memory/memory.sqlite       # the only source of truth
├── logs/                      # daily-rotated daemon log
│   ├── monolitod.log
│   └── instances/worker-*.log
├── run/                       # pid, lock, owner claim, update-restart.json
├── profiles/                  # profile workspaces (one per ProfileCreate)
│   └── <profile-id>/workspace/
├── scratchpad/                # tool output offload (>400KB tool results)
│                              # 24h TTL, cleaned at startup
├── searxng/settings.yml       # managed SearXNG configuration
├── grok_oauth.json            # cached Grok tokens (xai-oauth profile)
└── snapshots/                 # ContextOverflow trajectory dumps
```

Schema highlights ([`src/core/db/schema.ts`](../src/core/db/schema.ts)):

- `palace_nodes` — Memory Palace with `mutable=1` + `superseded_at` for history
- `vec_drawers`, `vec_messages` — sqlite-vec virtual tables, 1024d
- `background_tasks` — agent delegation tracking
- `worker_jobs` — sub-agent job recovery
- `profiles` — multi-profile with `__global__` fallback
- `sessions`, `messages`, `events`, `worklog` — turn persistence

See [`memory.md`](./memory.md) for the full schema map and the embedding
lifecycle.

---

## 5. Multi-agent model

The orchestrator ([`src/core/runtime/orchestrator.ts`](../src/core/runtime/orchestrator.ts))
owns sub-agent lifecycle. Sub-agents are profile-scoped sub-sessions running
in their **own Git worktree** with a temporary branch, so a worker cannot
collide with files in the main workspace.

| Aspect               | Value                                                |
|----------------------|------------------------------------------------------|
| Worker types         | `worker` · `researcher` · `verifier`                 |
| Modes                | `interactive` (synchronous parent wait) · `background` |
| Concurrency          | Max 6 active workers                                 |
| Per-worker budget    | 80k tokens                                           |
| Timeouts             | 10 min soft, 15 min hard                             |
| Recovery             | `recoverWorkerJobs()` on daemon restart              |
| Coordination         | `delegate_background_task` (coordinator-only)        |
| Profile inheritance  | BOOT wings inherit via `__global__` fallback         |

A sub-agent that is about to finalize must pass the full Ralph Loop
checklist before the orchestrator accepts its result. The worker
inherits the parent's `adultMode` flag, allowed-tools list, and profile
context.

---

## 6. Managed services

Each backing service has the same shape: `*ServiceStatus`, `*ServiceDeploy`,
`*ServiceStop`, `*ServiceRemove`, `*ServiceList`. The runtime probes the
HTTP endpoint, deploys via Docker if missing, and cleans conflicting legacy
containers (e.g. generic `whisper`) before starting its own.

| Service      | Image                                                | Port  | Default                                              |
|--------------|------------------------------------------------------|-------|------------------------------------------------------|
| STT          | `onerahmet/openai-whisper-asr-webservice`            | 9000  | `faster_whisper`, `base`, `es`, `vad=true`           |
| TTS          | hosted provider (MiniMax or OpenAI-compatible)       | n/a   | `speech-2.8-hd` (MiniMax) / `tts-1` (OpenAI)         |
| Vision       | Ollama + `moondream`                                 | 11435 | fallback CPU vision (heavy, ~60s)                    |
| Embeddings   | Ollama + `bge-m3`                                    | 11434 | 1024d vectors                                        |
| SearXNG      | `searxng/searxng`                                     | 8888  | `safe_search=0`, adult engines preconfigured         |

The previous TTS row (managed local container `travisvn/openai-edge-tts`
on port 5050) and its `TtsService*` tools were removed; TTS now runs
against a hosted provider. `uninstall.sh` still cleans up any leftover
`monolito-openai-edge-tts`, `tts-edge`, and `travisvn/openai-edge-tts`
containers from older installs.

SearXNG ships with `pornhub`, `redtube`, and `rule34` engines enabled and
routes queries to the adult category automatically when the session has
`/adult` on (see `safeSearch` toggling in `websearch/managed.ts`).

---

## 7. The event bus

[`src/core/events/bus.ts`](../src/core/events/bus.ts) is a 30-line internal
pub/sub. The bus is **session-scoped**: `runtime.onEvent` subscribes to a
specific session id or `"*"` for all sessions. Key events:

- `worker:completed` — fires the Telegram push for background sub-agents
- `message.received` — surfaces in the TUI as soon as the daemon appends the row
- `turn.completed` — drives the cost tracker and the `/cost` query
- `tool.start` / `tool.finish` — feed the Ralph Loop and the renderer
- `permission.request` — pauses the turn and prompts the user

There is no cross-process pub/sub. The CLI is the only subscriber; the bus
runs inside the daemon and is delivered through the same Unix socket that
carries requests and responses.

---

## 8. Configuration scope

Configuration is split between three layers:

1. **`.env` file** — bootstrap values: provider URL, API key, model id.
2. **`CONF_*` wings in SQLite** — runtime state: active profile, channel
   tokens, web search mode, heartbeat, permissions, policy. Mutated via
   `tool_manage_config` (read/write/get/set/activate_model).
3. **In-memory hot state** — `MONOLITO_ROOT`, registered listeners, MCP
   clients, abort controllers. Lost on restart by design.

Always use `tool_manage_config` for runtime changes; never edit the SQLite
file directly. The tool enforces Zod schemas on every wing and records
who-changed-what in the worklog.
