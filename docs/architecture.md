# Architecture

This document maps the runtime end-to-end. It is the canonical map of a Monolito
V2 process: from the binary entry point down to the JSONL line that persists a
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
│  ├─ runtime.ts            — the orchestration engine.                   │
│  ├─ modelAdapter.ts       Prompt build, provider recovery, streaming.  │
│  ├─ providers/            Anthropic SDK, OpenAI-compat, Ollama, Grok.   │
│  ├─ turnExecutionStack.ts Buffered side-effect tool calls.              │
│  ├─ sideEffectGuard.ts    LLM-driven side-effect approval.              │
│  ├─ veracityGuard.ts      Promised vs. executed mismatch detection.     │
│  └─ coherenceGuard.ts     Profile + memory contradiction detection.     │
├──────────────────────────────────────────────────────────────────────────┤
│  src/core/tools/          Tool registry: 60+ tools, Zod-validated input,│
│  └─ registry.ts           permission tiers, post-tool hooks, redacting. │
├──────────────────────────────────────────────────────────────────────────┤
│  src/core/session/        File-backed persistence layer.                │
│  ├─ store.ts              CRUD facade over fileStorage + markdownMemory.│
│  └─ src/core/storage/     Sessions, config, state JSON/JSONL, boot md.  │
├──────────────────────────────────────────────────────────────────────────┤
│  src/core/channels/       Telegram ingestion + delivery.                │
│  ├─ channelManager.ts     Lifecycle, menus, slash commands.             │
│  └─ telegramPoller.ts     Long-poll loop, attachment download, STT hook.│
├──────────────────────────────────────────────────────────────────────────┤
│  src/core/context/        Context Engine: head+tail truncation, smart  │
│  └─ toolResultGuard.ts,   compaction, recovery cascade.                 │
│  └─ smartCompactor.ts                                                        │
├──────────────────────────────────────────────────────────────────────────┤
│  src/core/{stt,vision}/managed.ts                                          │
│  └─ managed.ts            Docker lifecycle for each remaining managed    │
│                            service (STT, vision). TTS and web search     │
│                            no longer have managed backends — they run   │
│                            against hosted providers (MiniMax, OpenAI,   │
│                            Brave/Serper/Tavily).                         │
├──────────────────────────────────────────────────────────────────────────┤
│  memory/ + state/*.json   File-backed sessions, memory, graph, rules.   │
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
                   │    curated memory.md facts    │
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
        │ memory.md facts + recent chat.       │
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
         │ Inactivity timer (only when user idle) │
         │  • MemoryAgent  (cursor-based + event) │
         │  Conf: CONF_MEMORYAGENT wing         │
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

Everything stateful lives under `$MONOLITO_ROOT/memory/` as files, plus runtime
directories for logs, sockets, scratchpad, and profile workspaces.

```
~/.monolito/
├── .env                       # bootstrap configuration
├── memory/
│   ├── boot/*.md              # BOOT wings
│   ├── memory.md              # BOOT_MEMORY + filed facts
│   ├── config/CONF_*.json     # runtime configuration
│   ├── sessions/<id>/*.jsonl  # messages, worklog, events
│   ├── state/*.json|.jsonl    # graph, todos, cursors, telegram queue
│   └── profiles.json
├── logs/                      # daily-rotated daemon log
├── run/                       # pid, lock, owner claim
├── profiles/<id>/workspace/
├── scratchpad/                # tool output offload (>400KB)
├── grok_oauth.json
└── snapshots/                 # ContextOverflow trajectory dumps
```

See [`memory.md`](./memory.md) and [`memory-files-redesign.md`](./memory-files-redesign.md)
for the full layout.

---

## 5. Background maintenance

User-facing sub-agent delegation was removed. The only automatic background work
is **MemoryAgent** — an in-process turn triggered by inactivity that updates
BOOT wings and `memory.md` via `BootWrite` / `WorkspaceMemoryFiling`. See
[`background-agents.md`](./background-agents.md).

Profiles inherit BOOT content via global fallback when a profile-specific file
is absent.

---

## 6. Managed services

Each backing service has the same shape: `*ServiceStatus`, `*ServiceDeploy`,
`*ServiceStop`, `*ServiceRemove`, `*ServiceList`. The runtime probes the
HTTP endpoint, deploys via Docker if missing, and cleans conflicting legacy
containers (e.g. generic `whisper`) before starting its own.

| Service      | Backend                                              | Port  | Default                                              |
|--------------|------------------------------------------------------|-------|------------------------------------------------------|
| STT          | `onerahmet/openai-whisper-asr-webservice` (Docker)   | 9000  | `faster_whisper`, `base`, `es`, `vad=true`           |
| TTS          | hosted provider (MiniMax or OpenAI-compatible)       | n/a   | `speech-2.8-hd` (MiniMax) / `tts-1` (OpenAI)         |
| Vision       | Ollama + `moondream` (Docker)                        | 11435 | fallback CPU vision (heavy, ~60s)                    |
| Web search   | hosted API (Brave, Serper, or Tavily)                | n/a   | `default` (none; WebSearch/ImageSearch fail)         |

The previous TTS row (managed local container `travisvn/openai-edge-tts`
on port 5050) and its `TtsService*` tools were removed; TTS now runs
against a hosted provider. The previous SearXNG row (`searxng/searxng`
on port 8888) and its managed-container lifecycle were also removed;
web search now consumes hosted APIs only. `uninstall.sh` still cleans
up any leftover `monolito-searxng`, `searxng/searxng`,
`monolito-openai-edge-tts`, `tts-edge`, and `travisvn/openai-edge-tts`
containers from older installs.

Web search no longer has a managed backend. The adult-mode
`safeSearch` toggling is now done per-provider: Brave uses `safesearch=off`
or `moderate`, Serper uses `safe=off|active`, Tavily filters via the
`include_raw_content` flag and the session's adult flag.

---

## 7. The event bus

[`src/core/events/bus.ts`](../src/core/events/bus.ts) is a 30-line internal
pub/sub. The bus is **session-scoped**: `runtime.onEvent` subscribes to a
specific session id or `"*"` for all sessions. Key events:

- `message.received` — surfaces in the TUI as soon as the daemon appends a message
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
2. **`CONF_*.json` in `memory/config/`** — runtime state: active profile, channel
   tokens, web search mode, memoryagent, permissions, policy. Mutated via
   `tool_manage_config` (read/write/get/set/activate_model).
3. **In-memory hot state** — `MONOLITO_ROOT`, registered listeners, MCP
   clients, abort controllers. Lost on restart by design.

Always use `tool_manage_config` for runtime changes; never hand-edit JSON
config files to fake a change. The tool enforces Zod schemas on every wing
and records who-changed-what in the worklog.
