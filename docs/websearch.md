# Web Search

Monolito exposes web search configuration through `/websearch`.

The user-facing interface is menu-driven:

- In the local CLI, `/websearch` opens an interactive menu.
- In Telegram, `/websearch` opens an inline-button menu.

Users should not need to remember subcommand syntax for normal operation.

## Modes

Monolito currently supports two web search modes:

- `default`: leaves web lookup strategy to the runtime/model.
- `searxng`: enables a local SearxNG-backed flow for web and image search.

The active mode is stored in:

`CONF_WEBSEARCH`

Web search mode is a runtime-level setting, not a per-session setting.

## SearxNG lifecycle

When `searxng` is selected, Monolito:

- ensures Docker is available
- detects existing SearxNG containers by image and by name
- removes conflicting foreign SearxNG containers when needed
- prepares a persisted SearxNG `settings.yml`
- enables `json` output in that config
- launches the managed container `monolito-searxng`
- binds it to `127.0.0.1:8888`
- verifies not only `/healthz`, but also that the JSON API actually answers

The generated settings file is stored at:

`~/.monolito-v2/searxng/settings.yml`

This matters because the stock SearxNG image can come up with HTML-only formats enabled; Monolito patches the config so `format=json` works for internal tooling.

## Menu actions

The SearxNG menu can:

- switch the active mode to `searxng`
- start or restart the managed container
- stop the managed container
- remove the managed container
- list detected SearxNG containers
- clean all detected SearxNG containers
- run a test query against the local instance

The user-facing `/websearch` flow is menu-first in both supported surfaces:

- local CLI
- Telegram

## Image search integration

`ImageSearch` relies on the same local SearxNG instance at:

`http://127.0.0.1:8888`

That means `/websearch` and `ImageSearch` share:

- the same managed container name
- the same bind port
- the same JSON-enabled SearxNG config

If SearxNG is not already usable, `ImageSearch` can also prepare and launch it automatically.

## Telegram behavior

For Telegram, `/websearch` is handled as a menu entry point rather than a text-only configuration command.

Button actions are translated internally into runtime operations, but the user-facing flow stays menu-based.

## Persisted storage

Web search functionality uses:

- `CONF_WEBSEARCH`
- `~/.monolito-v2/searxng/settings.yml`

Operational logs for the running daemon still go to:

- `.monolito-v2/logs/monolitod-v2.log`
