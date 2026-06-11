# Model And Config

Monolito separates “current effective settings” from the model profile registry.

## Config wings

Runtime configuration is stored in SQLite Memory Palace `CONF_*` wings:

- `CONF_SYSTEM`: effective system/model settings
- `CONF_MODELS`: saved model profiles for the interactive model menu
- `CONF_CHANNELS`: channel, TTS, and STT configuration
- `CONF_WEBSEARCH`: persisted web search provider + apiKey

The previous managed-SearXNG `~/.monolito/searxng/settings.yml` is no
longer used. Web search runs against hosted provider APIs (Brave,
Serper, or Tavily); the API key is stored in `CONF_WEBSEARCH.apiKey`.

## Configuration scope

These config wings are runtime-level settings. They are not stored per session.

Session-specific runtime state such as chat history and conversation flow is tracked separately in session storage.

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

Text-to-speech settings are stored in:

- `CONF_CHANNELS`

Supported `/config set` fields for TTS are:

- `tts_base_url`
- `tts_api_key`
- `tts_provider` (`minimax` or `openai`)
- `tts_voice`
- `tts_model`
- `tts_format`
- `tts_speed`

The legacy fields `tts_managed`, `tts_auto_deploy`, and `tts_port` are no longer accepted and return an error.

MiniMax is the default TTS provider. If unset, it defaults to:

- `tts_provider = minimax`
- `tts_voice = female-shaonv`
- `tts_base_url = https://api.minimax.io/v1`

For OpenAI-compatible TTS backends, `tts_base_url` should point to the service root, for example:

- `https://api.openai.com/v1`

The speech-generation tool calls:

- `<tts_base_url>/v1/t2a_v2` for MiniMax
- `<tts_base_url>/v1/audio/speech` for OpenAI-compatible

The previous managed local TTS container (`travisvn/openai-edge-tts`) and its `TtsService*` tools were removed; the runtime now expects a hosted TTS provider.

## Runtime STT settings

Speech-to-text settings are also stored in:

- `CONF_CHANNELS`

Supported `/config set` fields for STT are:

- `stt_managed`
- `stt_auto_deploy`
- `stt_auto_transcribe`
- `stt_port`
- `stt_model`
- `stt_language`
- `stt_engine`
- `stt_vad_filter`

Recommended defaults for incoming Telegram audio are:

- `stt_managed = true`
- `stt_auto_deploy = true`
- `stt_auto_transcribe = true`
- `stt_engine = faster_whisper`
- `stt_model = small`
- `stt_language = es`

The managed STT service defaults to:

- image: `onerahmet/openai-whisper-asr-webservice:latest`
- endpoint: `http://127.0.0.1:<stt_port>/asr`

Managed STT deployment also removes conflicting legacy Whisper containers before starting its own service.

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
- `minimax` — provider de chat (endpoint Anthropic-compatible) **y** de
  `GenerateImage` (endpoint OpenAI-compatible en
  `https://api.minimax.io/v1/images/generations`, modelo `image-01`)

The first created profile becomes active automatically.

`GenerateImage` auto-detecta el proveedor de imagen siguiendo este orden:

1. `provider` explícito en el input del tool.
2. Perfil activo Grok / OAuth → Grok (`grok-imagine-image`).
3. Perfil activo con `provider="minimax"` o `baseUrl` conteniendo
   `minimax` → MiniMax (`image-01`).
4. Tokens Grok o `XAI_API_KEY` en env → Grok.
5. Perfil `openai_compatible` / `anthropic_compatible` → OpenAI/DALL-E.
6. Default → Grok.

Si forzás `provider: "minimax"` con un perfil activo distinto, se lee
`MINIMAX_API_KEY` del entorno (con fallback a `ANTHROPIC_AUTH_TOKEN`).

## Effective configuration

Monolito applies saved settings into the live process environment before model calls. If a field is missing in local settings, it can fall back to preserved system environment values.

Sensitive values such as API keys are masked in user-facing output.

## Provider recovery state machine

`src/core/runtime/modelAdapter.ts` uses a stateful `callProviderWithRetry` loop instead of a flat retry counter.

Current behavior:

- `ContextOverflowError` is not retried there; it is allowed to bubble so the runtime can compact the session and retry with a smaller prompt.
- `429` `RateLimitError` uses `retry-after` when present, otherwise exponential backoff.
- `503` / `529` overloads use a short bounded retry policy.
- transient network failures such as `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, and similar socket/connectivity errors are treated like overloads.
- `401` / `403` auth failures trigger one in-flight credential reload via `loadAndApplyModelSettings(process.env)` and then retry once with a refreshed effective config.

This keeps turns alive during temporary provider failures instead of aborting immediately.

## Prompt caching layout

Monolito now uses a Claude-Code-style prompt caching boundary inside `buildSystemPrompt`.

The prompt is split into:

- a static `system` block
- a dynamic `bootBlock`

The static block contains:

- core assistant instructions
- tool-use instructions
- the tool summary
- the BOOT entries (personality, identity, user profile, workspace rules, memory)

The dynamic block begins with the explicit marker:

- `=== DYNAMIC CONTEXT ===`

and then appends volatile per-turn data such as:

- workspace path
- current user request
- date context
- git context
- background task notifications

The goal is to keep the hash of the static block stable across turns so Anthropic prompt caching can turn repeated prompt reads into cache reads after the first request.

Operationally, if cache behavior is healthy, `/cost` should show `cache read` climbing after the first turn of a session.
