# Model And Config

Monolito separates “current effective settings” from the model profile registry.

## Settings files

- `~/.monolito-v2/settings.json`: active model settings used by the runtime.
- `~/.monolito-v2/models.json`: saved model profiles for the interactive model menu.
- `~/.monolito-v2/channels.json`: channel configuration.
- `~/.monolito-v2/websearch.json`: persisted web search mode selection.
- `~/.monolito-v2/searxng/settings.yml`: managed SearxNG configuration used when `searxng` mode is enabled.

Monolito also supports fallback migration from legacy v1 settings under:

- `~/.monolito/settings.json`

## Configuration scope

The persisted files in this section are runtime-level configuration files. They are not stored per session.

Session-specific runtime state such as chat history, adult mode, and conversation flow is tracked separately in session storage.

## Active runtime model settings

The runtime settings currently use the `anthropic_compatible` protocol and map to:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_MODEL`
- `API_TIMEOUT_MS`

These can be viewed or changed with:

- `/model info`
- `/model set <base_url|api_key|model> <value>`
- `/model reset`
- `/config show`
- `/config set <field> <value>`

## Runtime TTS settings

Text-to-speech settings are stored alongside channel settings in:

- `~/.monolito-v2/channels.json`

Supported `/config set` fields for TTS are:

- `tts_base_url`
- `tts_api_key`
- `tts_voice`
- `tts_model`
- `tts_format`
- `tts_speed`
- `tts_managed`
- `tts_auto_deploy`
- `tts_port`

For OpenAI-compatible TTS backends such as `openai-edge-tts`, `tts_base_url` should point to the service root, for example:

- `http://localhost:5050`

The speech-generation tool calls:

- `<tts_base_url>/v1/audio/speech`

If `tts_managed` is enabled, Monolito manages a local Docker container for TTS and uses:

- `http://127.0.0.1:<tts_port>`

## Model profiles

The model registry supports provider-oriented profiles with:

- provider
- base URL
- API key
- model
- active flag

Supported provider labels are:

- `openai_compatible`
- `anthropic_compatible`
- `ollama`
- `minimax`

The first created profile becomes active automatically.

## Effective configuration

Monolito applies saved settings into the live process environment before model calls. If a field is missing in local settings, it can fall back to preserved system environment values.

Sensitive values such as API keys are masked in user-facing output.
