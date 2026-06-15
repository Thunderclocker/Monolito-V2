# Monolito v2

Local orchestration runtime for AI agents: daemon + terminal UI, file-backed memory, structured tool execution, slash commands, Telegram channels, TTS/STT, and MCP support.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Thunderclocker/Monolito-V2/main/install.sh | bash
```

**Prerequisites:** Node.js 22+ and npm must already be installed. The installer
will not auto-install Node (we don't use `curl | sudo bash` for that internally
— it would be inconsistent with the runtime's own security checks). If Node is
missing, the installer will print concrete install instructions.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/Thunderclocker/Monolito-V2/main/uninstall.sh | bash -s -- --yes
```

Further documentation lives in [`docs/`](./docs/README.md).

## Core capabilities

- Daemon + CLI client with resumable local sessions
- File-backed runtime: sessions, worklog, events, BOOT wings (`memory/boot/*.md`), curated memory (`memory.md`), config JSON, and state JSONL
- Profile-based workspaces with deterministic `BOOT_*` wings as markdown files
- Long-term memory in `memory.md` (sections) plus a temporal knowledge graph in `state/knowledge_graph.jsonl`
- First-run bootstrap ritual that persists bootstrap state into BOOT wings and the knowledge graph
- Multi-agent orchestration with worker spawning, follow-up messaging, stop controls, and real filesystem isolation via Git Worktrees
- Tool harness for shell execution, web fetches, workspace file access, BOOT access, curated memory filing/recall, knowledge-graph tools, MCP calls, Telegram send, and task tracking
- OpenAI-compatible text-to-speech generation into local audio files, with Telegram audio/voice delivery tools
- Managed speech-to-text ingestion for Telegram audio and voice notes
- Slash-command interface for runtime inspection and control
- Channel ingestion and reply flow for Telegram chats
- Web search mode switching with a menu-driven SearxNG local backend for web and image search
- Persisted runtime configuration in `memory/config/CONF_*.json`, plus permission rules and post-tool hooks
- MCP bridge for listing tools/resources, reading resources, and calling remote MCP tools
- Agnostic model backend selection across Anthropic-compatible endpoints, OpenAI-compatible endpoints, and local Ollama instances
- Native Anthropic prompt caching layout with static prompt blocks separated from dynamic turn context
- In-flight provider recovery for `429`, `503`/`529`, auth expiration (`401`/`403`), and context overflow routing

## Architecture snapshot

Monolito is split into a few main layers:

- daemon/runtime: owns sessions, orchestration, slash commands, background work, channels, and logging
- model adapter: builds the prompt, injects BOOT/config, applies prompt-caching boundaries, and handles provider recovery state
- tool registry: exposes structured tools with permission checks and renderer metadata
- session store: persists messages, worklog, events, tasks, BOOT wings, memory sections, and the knowledge graph under `memory/`
- channels: Telegram ingestion/reply flow plus media handling
- managed services: optional local TTS, STT, and SearxNG lifecycle helpers

Operational state lives under `~/.monolito/memory/` (JSON, JSONL, markdown) plus runtime files for logs, sockets, and managed services.

## Memory system

- Session history, messages, worklog, and events are persisted as JSON/JSONL under `memory/sessions/`.
- BOOT identity lives in `memory/boot/*.md`; long-term digest in `memory/memory.md`.
- Knowledge graph triples live in `memory/state/knowledge_graph.jsonl`.
- Keyword recall scans `memory.md` sections and message JSONL (no SQLite, no embeddings).

## Multi-agent model

- Agents are represented as profile-scoped sub-sessions with their own isolated runtime context.
- A parent session can spawn worker, researcher, or verifier agents in parallel.
- Sub-agents report back through task notifications and can be continued or stopped explicitly.
- When isolation is enabled, each worker runs in its own Git Worktree with a temporary branch, so it cannot collide with files in the main workspace root.
- Profiles can be created dynamically and keep separate identity, workspace, and task lists.
- Main sessions can see curated bootstrap memory; worker sessions stay more isolated unless context is explicitly passed in.

## Tool harness

- Tools run through a permission-checked execution harness rather than free-form shell instructions.
- The registry includes local shell execution, MCP access, Telegram send, workspace read/write, BOOT read/write, memory filing/recall, knowledge-graph tools, todo/task tracking, and agent orchestration tools.
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

- Monolito can generate speech audio files through a hosted TTS provider (MiniMax or OpenAI-compatible).
- For Telegram-backed sessions, it can send those results as audio files or voice notes.
- By default, MiniMax is used as the TTS provider (using the active MiniMax model profile as a credential fallback if `tts_api_key` is unset). For OpenAI-compatible providers, set `tts_provider=openai` and `tts_base_url` to the API root (e.g. `https://api.openai.com/v1`).
- `VoiceClone` uploads a 10s–5min sample to MiniMax and persists the cloned voice as an alias in `tts.clonedVoices`.
- The previous managed local TTS container (`travisvn/openai-edge-tts`) and its `/tts` lifecycle commands were removed; `uninstall.sh` still cleans up any leftover containers from older installs.
- See [`docs/tts.md`](./docs/tts.md) for the full configuration reference.

## Speech To Text

- Incoming Telegram audio and voice notes can be transcribed automatically before they reach the model.
- Monolito can manage its own local Docker STT backend with `/stt`.
- The default managed STT flow uses a Whisper webservice with `faster_whisper` as the engine.
- Managed deployment cleans conflicting legacy Whisper containers before starting its own service.
- See [`docs/stt.md`](./docs/stt.md) and [`docs/channels-and-telegram.md`](./docs/channels-and-telegram.md) for the full STT configuration and runtime behavior.

## Web search

- `/websearch` opens an interactive menu in the local CLI and a button-based menu in Telegram.
- The available providers are `default` (no search), `brave`, `serper`, and `tavily`. All three hosted API providers require an API key in `CONF_WEBSEARCH.apiKey`.
- The previous local SearXNG managed-container flow was removed; `WebSearch` and `ImageSearch` now consume hosted provider APIs only. Legacy SearXNG containers from old installs are cleaned up by `uninstall.sh`.
- The active provider and key are stored in `memory/config/CONF_WEBSEARCH.json`.

## Interactive menus

- `/model` opens the interactive model selection and configuration flow.
- `/channels` opens Telegram channel configuration in the CLI and an inline menu in Telegram.
- `/websearch` opens web search configuration in the CLI and an inline menu in Telegram.
- Menu-driven commands are intended as the main user-facing interface for operational configuration.

## Configuration scope

- Model settings are global to the runtime.
- Channel and Telegram settings are global to the runtime.
- Web search mode is global to the runtime.
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
- `/new`
- `/reset`

`/new` starts a fresh session without clearing profile memory. `/reset` starts over and clears profile-scoped memory data while preserving runtime configuration.

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
git clone https://github.com/Thunderclocker/Monolito-V2.git && cd Monolito-V2 && ./install.sh
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

- Runtime config: `~/.monolito/memory/config/CONF_*.json`
- Session + memory data: `~/.monolito/memory/` (boot, sessions, state, memory.md)
- Daemon log: `~/.monolito/logs/monolitod.log`
- Profile workspaces: `~/.monolito/profiles/<profile-id>/workspace/`
