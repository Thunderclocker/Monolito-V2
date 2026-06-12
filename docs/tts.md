# TTS

Monolito can generate speech audio with a hosted TTS provider and send it to Telegram.

## What it does

When the user asks Monolito to speak, send audio, or send a voice note, the intended flow is:

- generate speech with `GenerateSpeech`
- send the result with `TelegramSendAudio` or `TelegramSendVoice`

The runtime prompt explicitly instructs the model to prefer these tools over ad-hoc shell synthesis.

## Supported providers

`GenerateSpeech` accepts two TTS providers, controlled by `tts_provider` (which defaults to `minimax` if unset):

### MiniMax (default provider)

- Endpoint: `POST /v1/t2a_v2` on `https://api.minimax.io/v1`
- Auth: `tts.apiKey` (or `MINIMAX_API_KEY` / `ANTHROPIC_AUTH_TOKEN` env var, or the active model profile if it is `minimax`)
- Voice resolution: aliases in `tts.clonedVoices` are mapped to their `voice_id` automatically; if the voice is an alias, the provider is forced to `minimax` even if `tts_provider` is unset.
- `model` defaults to `tts.t2aModel` (or `speech-2.8-hd`).
- Speed is clamped to MiniMax's range (0.5–2.0).

### OpenAI-compatible (hosted)

- Endpoint: `POST /v1/audio/speech` on `tts.baseUrl` (e.g. `https://api.openai.com/v1`)
- Auth: `tts.apiKey`
- Voice, model, speed, and `response_format` follow the OpenAI Audio API spec.

## Configuration

TTS settings live in `CONF_CHANNELS`. Relevant config fields:

- `tts_base_url` (OpenAI-compatible provider endpoint)
- `tts_api_key`
- `tts_provider` (`minimax` | `openai`)
- `tts_voice`
- `tts_model` (OpenAI: `tts-1`, `tts-1-hd`; MiniMax: `speech-2.8-hd`, etc.)
- `tts_format` (`mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`)
- `tts_speed` (0.25–4.0 for OpenAI; 0.5–2.0 for MiniMax)
- `tts_language_boost` (Optional phonetic language optimization for MiniMax, e.g. `Spanish`, `English`, `Portuguese`, `auto`)
- `tts.clonedVoices` (alias → `voice_id` map; MiniMax only)
- `tts.defaultClonedVoice`
- `tts.t2aModel`

Typical MiniMax setup:

```bash
monolito /config set tts_provider minimax
monolito /config set tts_api_key sk-cp-...
monolito /config set tts_base_url https://api.minimax.io/v1
```

Typical OpenAI-hosted setup:

```bash
monolito /config set tts_provider openai
monolito /config set tts_base_url https://api.openai.com/v1
monolito /config set tts_api_key sk-...
monolito /config set tts_voice alloy
```

## Voice cloning

Use `VoiceClone` to upload a 10s–5min audio sample (mp3/m4a/wav/ogg, ≤20MB) and persist it as an alias. The cloned voice can then be invoked from `GenerateSpeech` by passing the alias as `voice`.

## Removed: managed local TTS container

Earlier versions of Monolito shipped a managed local TTS service (`travisvn/openai-edge-tts`) and a set of `TtsService*` tools to deploy/stop/remove/list its container. That backend was removed; the runtime now expects a hosted TTS provider (MiniMax or OpenAI-compatible).

If an old deployment still has the `TtsService*` tools referenced in the LLM's toolset, the user must run `/update` to deploy this build. The `/config set tts_managed`, `tts_auto_deploy`, and `tts_port` slash commands now return an error pointing to the hosted providers.

## Telegram behavior

For Telegram-backed sessions, Monolito can send:

- normal text replies
- audio files
- voice notes

For spoken Telegram replies, the intended order is:

- `GenerateSpeech`
- `TelegramSendAudio` or `TelegramSendVoice`

## Operational note

Do not patch the live VPS checkout by hand if you rely on `/update`.

`/update` uses a fast-forward Git pull. Local uncommitted edits in the live checkout can block updates until they are committed, stashed, or discarded.

## Related STT

Incoming Telegram audio and voice notes can be transcribed automatically through the managed STT flow documented in [`stt.md`](./stt.md).
