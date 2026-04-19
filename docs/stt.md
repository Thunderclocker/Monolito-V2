# STT (Speech-To-Text)

Monolito can automatically transcribe incoming Telegram audio and voice notes using a managed local STT backend.

## What it does

When a Telegram chat sends an audio file or a voice note, Monolito:
- Downloads the file locally.
- Transcribes the audio using the managed STT service.
- Injects the transcript into the message context so the model can understand it without "listening" to the audio directly.

## Managed service

Monolito supports a managed Docker-backed STT service using `onerahmet/openai-whisper-asr-webservice:latest`.

When managed STT is enabled, Monolito can:
- Deploy the service automatically when audio is received.
- Use `faster_whisper` as the default high-performance engine.
- Fallback to smaller models (e.g., `base`, `tiny`) if the requested model fails to load due to hardware constraints.
- Apply a VAD (Voice Activity Detection) filter to improve transcript quality.

The managed container defaults to:
- Container name: `monolito-faster-whisper`
- Bind address: `127.0.0.1:9000`
- Default engine: `faster_whisper`
- Default model: `base`
- Default language: `es` (Spanish)

## Configuration

STT settings live in `CONF_CHANNELS`.

Relevant config fields:
- `stt_managed`: Enable/disable managed Docker deployment.
- `stt_auto_deploy`: Automatically start the container when needed.
- `stt_auto_transcribe`: Automatically transcribe incoming Telegram audio.
- `stt_port`: Local port for the ASR webservice (default: `9000`).
- `stt_model`: Whisper model to use (e.g., `base`, `small`, `medium`).
- `stt_language`: Default language code for transcription (e.g., `es`, `en`).
- `stt_engine`: Transcription engine (`faster_whisper`, `openai_whisper`, `whisperx`).
- `stt_vad_filter`: Enable/disable Voice Activity Detection.

Typical managed setup:
```bash
monolito /config set stt_language es
monolito /config set stt_model base
monolito /config set stt_managed true
monolito /config set stt_auto_transcribe true
monolito /stt deploy
```

## Slash commands

The managed lifecycle is exposed through:
- `/stt show`: Display current configuration and service status.
- `/stt status`: Alias for `show`.
- `/stt on`: Enable managed STT and auto-transcription.
- `/stt off`: Disable auto-transcription.
- `/stt deploy`: Force deployment of the Docker container.
- `/stt stop`: Stop the running container.
- `/stt remove`: Remove the container and its image reference.
- `/stt list`: List detected STT containers.

## Related
- [Channels and Telegram](./channels-and-telegram.md)
- [TTS](./tts.md)
