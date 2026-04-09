# Slash Commands

Monolito exposes runtime control commands in the CLI and, where supported, through channel sessions such as Telegram.

## Main commands

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
- `/tts`
- `/adult`
- `/websearch`
- `/new`

## What they do

- `/status`: dumps current session state, redacted model settings, and tool list.
- `/sessions`: lists known sessions.
- `/history`: shows recent worklog entries for the current session.
- `/cost`: prints current token/cost accounting.
- `/compact`: compacts older session messages and triggers a memory review first.
- `/stats`: shows message count, character count, timestamps, and session state.
- `/doctor`: runs a quick environment and runtime health summary.
- `/update`: fetches from `origin`, fast-forwards the current branch, stashes local changes if needed, and schedules a daemon restart.
- `/channels`: opens Telegram channel configuration controls through menus in the CLI and Telegram.
- `/tts`: shows or controls the managed local TTS service lifecycle.
- `/websearch`: opens web search configuration controls through menus in the CLI and Telegram.
- `/new`: resets the current session and restarts the agent startup sequence.
- `/config set tts_base_url|tts_api_key|tts_voice|tts_model|tts_format|tts_speed|tts_managed|tts_auto_deploy|tts_port <value>`: configures the runtime TTS backend used by speech-generation tools.
- `/tts deploy|stop|remove|list`: manages the local Docker-backed TTS service and cleans conflicting legacy Edge TTS containers when needed.

## Configuration scope

- `/model`, `/channels`, `/config`, and `/websearch` act on runtime-level configuration.
- `/adult` acts on the current session only.
- `/new` resets only the current session.
- Telegram chat sessions remain isolated by `telegram-<chatId>`.

## Interactive menus

Some commands are also entry points into interactive menus in the CLI or Telegram:

- `/model`
- `/channels`
- `/websearch`

## Notes

- `/adult` toggles adult mode for the current session only.
- Some internal subcommands still exist behind `/channels` and `/websearch` to support callbacks and automation, but they are not the intended user-facing interface.
- Unknown slash commands return an explicit error string rather than silently falling through.
