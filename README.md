# Monolito v2

Local orchestration runtime with daemon mode, terminal UI, persistent sessions, SQLite-first memory, multi-agent delegation, structured tool execution, slash commands, channel integration, and basic MCP support.

Further documentation lives in [`docs/`](./docs/README.md).

## Core capabilities

- Daemon + CLI client with resumable local sessions
- SQLite-backed runtime for sessions, worklog, events, BOOT wings, canonical memory, verbatim long-term memory, and the temporal knowledge graph
- Profile-based workspaces with deterministic `BOOT_*` wings stored in SQLite instead of legacy markdown memory files
- Canonical memory slots for stable assistant/user facts such as assistant name, preferred user name, location, and timezone
- Verbatim long-term memory filing into SQLite `memory.sqlite`, plus a temporal knowledge graph for subject-predicate-object facts with validity windows
- First-run bootstrap ritual that persists bootstrap state into BOOT wings while stable facts can also live in canonical memory and the graph
- Multi-agent orchestration with worker spawning, follow-up messaging, stop controls, and real filesystem isolation via Git Worktrees
- Tool harness for shell execution, web fetches, workspace file access, BOOT access, canonical memory access, Memory Palace filing/recall, knowledge-graph tools, MCP calls, Telegram send, and task tracking
- OpenAI-compatible text-to-speech generation into local audio files, with Telegram audio/voice delivery tools
- Managed speech-to-text ingestion for Telegram audio and voice notes
- Slash-command interface for runtime inspection and control
- Channel ingestion and reply flow for Telegram chats
- Web search mode switching with a menu-driven SearxNG local backend for web and image search
- Persisted runtime configuration in SQLite `CONF_*` wings, plus permission rules and post-tool hooks
- MCP bridge for listing tools/resources, reading resources, and calling remote MCP tools
- Agnostic model backend selection across Anthropic-compatible endpoints, OpenAI-compatible endpoints, and local Ollama instances
- Native Anthropic prompt caching layout with static prompt blocks separated from dynamic turn context
- In-flight provider recovery for `429`, `503`/`529`, auth expiration (`401`/`403`), and context overflow routing

## Architecture snapshot

Monolito is split into a few main layers:

- daemon/runtime: owns sessions, orchestration, slash commands, background work, channels, and logging
- model adapter: builds the prompt, injects BOOT/canonical memory/config, applies prompt-caching boundaries, and handles provider recovery state
- tool registry: exposes structured tools with permission checks and renderer metadata
- session store: persists messages, worklog, events, tasks, BOOT wings, canonical memory, Memory Palace entries, and the temporal knowledge graph in SQLite
- channels: Telegram ingestion/reply flow plus media handling
- managed services: optional local TTS, STT, and SearxNG lifecycle helpers

The runtime does not rely on workspace markdown files for identity or memory. The operational state lives in SQLite `memory.sqlite`, plus runtime files under `~/.monolito-v2/` for logs, sockets, caches, and managed services.

## Memory system

- Session history, messages, worklog entries, runtime events, BOOT wings, canonical slots, Memory Palace entries, and graph triples are persisted locally in SQLite.
- Long-term memory has four layers:
  - `BOOT_*` for deterministic bootstrap state
  - canonical memory for stable assistant/user facts
  - Memory Palace for broader durable context and verbatim turn capture
  - temporal knowledge graph for time-scoped relations
- Verbatim conversation storage now writes the latest `USER` / `ASSISTANT` turn pair directly into SQLite under `HISTORY/verbatim`.
- Memory Palace entries are stored as `wing`, `room`, optional `key`, and `content`.
- Knowledge graph entries are stored as `subject`, `predicate`, `object`, `valid_from`, and optional `valid_to`.
- `SHARED` wings are visible across profiles; other Memory Palace entries and graph triples stay profile-scoped.
- Recall supports structural filters (`wing`, `room`, `key`) and semantic lookup with local embeddings.
- Embeddings use a local `@xenova/transformers` model and are warmed in the background at daemon startup.
- If embeddings are unavailable, Monolito degrades cleanly: filing can continue without vectors and semantic recall falls back to recent non-semantic memory.
- Session history can also be compacted while keeping continuity markers.

### Background Memory Agent

- Monolito runs a background `Memory Agent` that reviews recent conversation and proposes updates for `USER` and `MEMORY` without interrupting the main reply flow.
- The same review pass also stores the last conversation turn verbatim into SQLite, without asking the LLM to invent summaries for the Memory Palace.
- Stable profile facts can also be promoted into canonical memory.
- It is triggered after normal turns, before `/compact`, and before session resets such as `/new`.
- Operational logging is emitted through the daemon log under the `memory-agent` logger category.
- Memory Agent updates are also summarized into the session worklog when something is applied.
- See `docs/memory-agent.md` for routing and behavior details.

## Multi-agent model

- Agents are represented as profile-scoped sub-sessions with their own isolated runtime context.
- A parent session can spawn worker, researcher, or verifier agents in parallel.
- Sub-agents report back through task notifications and can be continued or stopped explicitly.
- When isolation is enabled, each worker runs in its own Git Worktree with a temporary branch, so it cannot collide with files in the main workspace root.
- Profiles can be created dynamically and keep separate identity, workspace, and task lists.
- Main sessions can see curated bootstrap and canonical memory; worker sessions stay more isolated unless context is explicitly passed in.

## Tool harness

- Tools run through a permission-checked execution harness rather than free-form shell instructions.
- The registry includes local shell execution, MCP access, Telegram send, workspace read/write, BOOT read/write, canonical memory read/write, memory filing/recall, knowledge-graph tools, todo/task tracking, and agent orchestration tools.
- Tool starts, finishes, failures, and summaries are emitted as structured runtime events and appended to the worklog.
- Post-tool hooks and per-profile/session permission rules are supported.
- Session forensics is also tool-driven, so the assistant can inspect messages, worklog, and events before answering questions about what happened in a session.

## Model runtime

- Anthropic calls are arranged for prompt caching by keeping the static prompt block stable and appending a `=== DYNAMIC CONTEXT ===` section separately.
- Provider calls use a retry state machine instead of a flat loop.
- `429` rate limits honor `retry-after` when available and otherwise use exponential backoff.
- `503` / `529` provider overloads and retriable network failures use a short bounded retry policy.
- `401` / `403` auth failures trigger a one-time in-flight credential reload before surfacing the error.
- `ContextOverflowError` is allowed to bubble so the runtime can compact the session and retry with a smaller prompt.

## Channels

- Telegram is currently the implemented external channel.
- Incoming Telegram messages are mapped to dedicated `telegram-<chatId>` sessions.
- The runtime can mirror replies, typing indicators, and agent updates back to the originating chat.
- Allowed chat IDs can be restricted from the channel configuration menu.
- Telegram slash commands can open inline menus for configuration-oriented actions such as `/channels` and `/websearch`.

## Text To Speech

- Monolito can generate speech audio files through an OpenAI-compatible TTS backend.
- For Telegram-backed sessions, it can send those results as audio files or voice notes.
- The default Spanish Argentina voice is `es-AR-ElenaNeural`.
- Monolito can manage its own local Docker TTS backend with `/tts`.
- Managed deployment cleans conflicting legacy Edge TTS containers such as `tts-edge`.
- Recommended managed setup uses `tts_managed=true` and `tts_auto_deploy=true`.
- See [`docs/tts.md`](./docs/tts.md) for the complete lifecycle and configuration flow.

## Speech To Text

- Incoming Telegram audio and voice notes can be transcribed automatically before they reach the model.
- Monolito can manage its own local Docker STT backend with `/stt`.
- The default managed STT flow uses a Whisper webservice with `faster_whisper` as the engine.
- Managed deployment cleans conflicting legacy Whisper containers before starting its own service.
- See [`docs/stt.md`](./docs/stt.md) and [`docs/channels-and-telegram.md`](./docs/channels-and-telegram.md) for the full STT configuration and runtime behavior.

## Web search

- `/websearch` opens an interactive menu in the local CLI and a button-based menu in Telegram.
- The available modes are `default` and `searxng`.
- Selecting `searxng` prepares and starts a local Docker container bound to `127.0.0.1:8888`.
- Monolito also prepares a persisted `settings.yml` so the SearxNG JSON API is enabled, which is required by `ImageSearch`.
- The menu can list detected SearxNG containers, stop the managed container, remove it, clean conflicting containers, and run a test query.
- `ImageSearch` uses the same managed SearxNG backend as `/websearch`.
- Web search mode is stored in the SQLite `CONF_WEBSEARCH` wing.
- SearxNG settings are stored in `~/.monolito-v2/searxng/settings.yml`.

## Interactive menus

- `/model` opens the interactive model selection and configuration flow.
- `/channels` opens Telegram channel configuration in the CLI and an inline menu in Telegram.
- `/websearch` opens web search configuration in the CLI and an inline menu in Telegram.
- Menu-driven commands are intended as the main user-facing interface for operational configuration.

## Configuration scope

- Model settings are global to the runtime.
- Channel and Telegram settings are global to the runtime.
- Web search mode is global to the runtime.
- Adult mode is session-scoped and can differ between conversations.
- Telegram chats map to stable `telegram-<chatId>` sessions, so each chat keeps its own session history and state.

## Slash commands

- `/help`
- `/status`
- `/sessions`
- `/tool <name> <json>`
- `/mcp tools <server>`
- `/mcp resources <server>`
- `/mcp read <server> <uri>`
- `/mcp call <server> <tool> <json>`
- `/model`
- `/model info`
- `/model set <base_url|api_key|model> <value>`
- `/model reset`
- `/history [limit]`
- `/cost`
- `/compact [max-messages]`
- `/stats`
- `/doctor`
- `/update`
- `/channels`
- `/config [show|set <field> <value>]`
- `/tts [show|on|off|deploy|stop|remove|list|status]`
- `/stt [show|on|off|deploy|stop|remove|list|status]`
- `/websearch`
- `/adult`
- `/new`

`/update` fetches from `origin`, applies a fast-forward pull on the current branch, and restarts the daemon automatically. If the working tree has local changes, Monolito backs them up to a git stash automatically before updating.

Operationally, `/update` is meant to be a one-step refresh path for the running daemon rather than a manual multi-step deploy sequence.

## Installation

An installer is not strictly required, but it helps standardize setup for people cloning the repository from GitHub.

Prerequisites:

- Node.js 22 or newer
- npm
- Build tooling required by native Node modules on your OS

Install with:

```bash
git clone https://github.com/Thunderclocker/Monolito-V2.git
cd Monolito-V2
./install.sh
```

Manual install is also valid:

```bash
npm install
```

The installer creates a `monolito` launcher in `~/.local/bin/monolito`.
If your shell does not find it automatically, add `~/.local/bin` to your `PATH`.
The installer also aborts if it detects a duplicate nested clone such as `Monolito-V2/Monolito-V2`, because that can break `/update`.

To remove all Monolito traces, including the current repository directory:

```bash
./uninstall.sh
```

Use `./uninstall.sh --keep-repo` if you want to keep the current repository directory and remove everything else.

## Run

```bash
monolito
```

The CLI starts the daemon automatically when it is not already running.
On a brand-new workspace, Monolito also starts a first-run onboarding ritual and asks for identity/user details one question at a time. When that bootstrap is completed, it replaces `BOOT_BOOTSTRAP` with a completion note so the ritual does not repeat.

## Quick checks

```bash
monolito /status
monolito -p '/tool pwd'
monolito -p '/mcp resources demo'
monolito -p '/tts status'
monolito -p '/stt status'
```

## Notes

- Runtime config lives in SQLite `CONF_*` wings: `CONF_SYSTEM`, `CONF_MODELS`, `CONF_CHANNELS`, `CONF_WEBSEARCH`
- SearxNG settings: `~/.monolito-v2/searxng/settings.yml`
- Session data: `.monolito-v2/` relative to the project root (created on first daemon start)
- Local memory database: `.monolito-v2/memory/memory.sqlite`
- Daemon log: `.monolito-v2/logs/monolitod.log`
- Profile workspaces: `.monolito-v2/profiles/<profile-id>/workspace/`
