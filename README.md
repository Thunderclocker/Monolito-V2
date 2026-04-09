# Monolito v2

Local orchestration runtime with daemon mode, terminal UI, persistent sessions, SQLite memory, multi-agent delegation, tool harness execution, slash commands, channel integration, and basic MCP support.

Further documentation lives in [`docs/`](./docs/README.md).

## Core capabilities

- Daemon + CLI client with resumable local sessions
- SQLite-backed session storage, worklog, events, and semantic memory retrieval
- Profile-based workspaces with injected core files such as `SOUL.md`, `AGENTS.md`, `USER.md`, `TOOLS.md`, and `MEMORY.md`
- First-run bootstrap ritual that asks for agent identity and user profile, then persists the result into core files
- Multi-agent orchestration with worker spawning, follow-up messaging, and stop controls
- Tool harness for shell execution, web fetches, workspace file access, memory filing/recall, MCP calls, Telegram send, and task tracking
- OpenAI-compatible text-to-speech generation into local audio files, with Telegram audio/voice delivery tools
- Slash-command interface for runtime inspection and control
- Channel ingestion and reply flow for Telegram chats
- Web search mode switching with a menu-driven SearxNG local backend for web and image search
- Persisted model/profile settings, permission rules, and post-tool hooks
- MCP bridge for listing tools/resources, reading resources, and calling remote MCP tools
- Agnostic model backend selection across Anthropic-compatible endpoints, OpenAI-compatible endpoints, and local Ollama instances

## Memory system

- Session history, messages, worklog entries, and runtime events are persisted locally.
- Long-term memory uses SQLite plus `sqlite-vec` vector search with 384-dimension embeddings.
- Memories are stored as `wing` and `room` entries in a "Memory Palace" structure.
- `SHARED` wings are visible across profiles; other wings stay private to the current profile.
- Recall supports structural filters (`wing`, `room`, `key`) and semantic lookup with embeddings.
- Session history can also be compacted while keeping continuity markers.

### Background Memory Agent

- Monolito runs a background `Memory Agent` that reviews recent conversation and proposes memory updates without interrupting the main reply flow.
- It can write to `USER.md` for stable personal preferences, `MEMORY.md` for durable relational context, and the SQLite Memory Palace for useful but less canonical context.
- The agent is intentionally stricter for `USER.md` and `MEMORY.md` than for Memory Palace entries.
- It is triggered after normal turns, before `/compact`, and before session resets such as `/new`.
- Actions and failures are logged to `.monolito-v2/logs/memory-agent.log`.
- Memory Agent updates are also summarized into the session worklog when something is applied.
- See `docs/memory-agent.md` for routing and behavior details.

## Multi-agent model

- Agents are represented as profile-scoped sub-sessions with their own workspace bootstrap files.
- A parent session can spawn worker, researcher, or verifier agents in parallel.
- Sub-agents report back through task notifications and can be continued or stopped explicitly.
- Profiles can be created dynamically and keep separate identity, workspace, and task lists.
- Main sessions auto-load curated memory; background agent sessions are isolated more tightly.

## Tool harness

- Tools run through a permission-checked execution harness rather than free-form shell instructions.
- The registry includes local shell execution, MCP access, Telegram send, workspace read/write, memory filing/recall, todo/task tracking, and agent orchestration tools.
- Tool starts, finishes, failures, and summaries are emitted as structured runtime events and appended to the worklog.
- Post-tool hooks and per-profile/session permission rules are supported.

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
- See [`docs/channels-and-telegram.md`](./docs/channels-and-telegram.md) and [`docs/model-and-config.md`](./docs/model-and-config.md) for the full STT configuration and runtime behavior.

## Web search

- `/websearch` opens an interactive menu in the local CLI and a button-based menu in Telegram.
- The available modes are `default` and `searxng`.
- Selecting `searxng` prepares and starts a local Docker container bound to `127.0.0.1:8888`.
- Monolito also prepares a persisted `settings.yml` so the SearxNG JSON API is enabled, which is required by `ImageSearch`.
- The menu can list detected SearxNG containers, stop the managed container, remove it, clean conflicting containers, and run a test query.
- `ImageSearch` uses the same managed SearxNG backend as `/websearch`.
- Web search mode is stored in `~/.monolito-v2/websearch.json`.
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
- `/tts`
- `/stt`
- `/config [show|set <field> <value>]`
- `/websearch`
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

## Run

```bash
monolito
```

The CLI starts the daemon automatically when it is not already running.
On a brand-new workspace, Monolito also starts a first-run onboarding ritual and asks for identity/user details one question at a time. When that bootstrap is completed, it clears `BOOTSTRAP.md` so the ritual does not repeat.

## Quick checks

```bash
monolito /status
monolito -p '/tool pwd'
monolito -p '/mcp resources demo'
monolito -p '/tts status'
monolito -p '/stt status'
```

## Notes

- Settings: `~/.monolito-v2/settings.json`
- Model profiles: `~/.monolito-v2/models.json`
- Channel config: `~/.monolito-v2/channels.json`
- Web search config: `~/.monolito-v2/websearch.json`
- SearxNG settings: `~/.monolito-v2/searxng/settings.yml`
- Session data: `.monolito-v2/` relative to the project root (created on first daemon start)
- Local memory database: `.monolito-v2/memory/memory.sqlite`
- Daemon log: `.monolito-v2/logs/monolitod-v2.log`
- Memory Agent log: `.monolito-v2/logs/memory-agent.log`
- Profile workspaces: `.monolito-v2/profiles/<profile-id>/workspace/`
- Legacy v1 settings fallback: `~/.monolito/settings.json`
