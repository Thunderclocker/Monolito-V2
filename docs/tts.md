# TTS

Monolito can generate speech audio, send it to Telegram, and manage its own local TTS backend.

## What it does

When the user asks Monolito to speak, send audio, or send a voice note, the intended flow is:

- generate speech with `GenerateSpeech`
- send the result with `TelegramSendAudio` or `TelegramSendVoice`

The runtime prompt explicitly instructs the model to prefer these tools over ad-hoc shell synthesis.

## Default voice

The default Spanish Argentina voice is:

- `es-AR-ElenaNeural`

If `tts_voice` is not configured, Monolito falls back to that voice automatically.

## Managed service

Monolito supports a managed Docker-backed TTS service using `travisvn/openai-edge-tts:latest`.

When managed TTS is enabled, Monolito can:

- deploy the service automatically when speech is requested
- stop the service
- remove the service
- inspect current status
- clean conflicting legacy Edge TTS containers before deployment

The managed container defaults to:

- container name: `monolito-openai-edge-tts`
- bind address: `127.0.0.1:<tts_port>`
- default port: `5050`

Legacy containers such as `tts-edge` are treated as conflicts and are removed by the managed deployment flow.

## Configuration

TTS settings live in:

- `~/.monolito-v2/channels.json`

Relevant config fields:

- `tts_base_url`
- `tts_api_key`
- `tts_voice`
- `tts_model`
- `tts_format`
- `tts_speed`
- `tts_managed`
- `tts_auto_deploy`
- `tts_port`

Typical managed setup:

```bash
monolito /config set tts_voice es-AR-ElenaNeural
monolito /config set tts_api_key monolito-tts
monolito /config set tts_managed true
monolito /config set tts_auto_deploy true
monolito /tts deploy
```

## Slash commands

The managed lifecycle is exposed through:

- `/tts show`
- `/tts status`
- `/tts on`
- `/tts off`
- `/tts deploy`
- `/tts stop`
- `/tts remove`
- `/tts list`

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
