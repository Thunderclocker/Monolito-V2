# Web Search

Monolito exposes web search configuration through `/websearch`.

The user-facing interface is menu-driven:

- In the local CLI, `/websearch` opens an interactive menu.
- In Telegram, `/websearch` opens an inline-button menu.

Users should not need to remember subcommand syntax for normal operation.

## Providers

Monolito's `WebSearch` and `ImageSearch` tools consume **hosted search API providers only**. The local self-hosted meta-search backend (SearXNG) was removed.

Supported providers:

- `default` — no provider configured. `WebSearch` and `ImageSearch` will return a clear error pointing the user to set up one of the providers below.
- `brave` — Brave Search API (`https://api.search.brave.com/res/v1/web/search` and `/res/v1/images/search`). Requires `CONF_WEBSEARCH.apiKey`. Setting `apiKey` alone auto-enables `provider=brave`.
- `serper` — Serper (Google) (`https://google.serper.dev/search` and `/images`). Requires `CONF_WEBSEARCH.apiKey`.
- `tavily` — Tavily (`https://api.tavily.com/search`). Requires `CONF_WEBSEARCH.apiKey`.

The active provider is stored in `CONF_WEBSEARCH` and is a runtime-level setting, not a per-session setting.

## Configuration

```bash
# Pick a provider
/config set websearch_provider brave
/config set websearch_api_key <your-brave-key>

# Or via tool_manage_config action='set'
# CONF_WEBSEARCH.provider = "brave"
# CONF_WEBSEARCH.apiKey = "<key>"
```

When the user pastes a hosted search API key in chat, the runtime auto-saves `CONF_WEBSEARCH`, redacts the key from persisted messages/worklog, and seeds proactive Ralph tasks (search → answer) that the top-level Ralph loop tracks until completed.

## Menu actions

The `/websearch` menu can:

- switch the active provider (`default`, `brave`, `serper`, `tavily`)
- remind the user where to set the API key

The previous `/websearch` submenu (deploy/stop/remove SearXNG container, run a test query against a local instance) is gone.

## Image search integration

`ImageSearch` uses the same provider configuration as `WebSearch`. Each provider has its own image-search endpoint (Brave Images, Serper Images, Tavily's `include_images: true`).

## Telegram behavior

For Telegram, `/websearch` is handled as a menu entry point rather than a text-only configuration command.

Button actions are translated internally into runtime operations, but the user-facing flow stays menu-based.

## Persisted storage

Web search functionality uses:

- `CONF_WEBSEARCH` (the provider enum and apiKey)

Operational logs for the running daemon still go to:

- `~/.monolito/logs/monolitod.log`
