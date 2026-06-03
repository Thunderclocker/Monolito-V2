# Docs

This folder is the canonical documentation for Monolito V2. The
top-level `README.md` is a short feature summary; the docs here are
the operational map.

## Start here

- [`architecture.md`](./architecture.md) — end-to-end map of the
  runtime, including the per-turn flow diagram. **Read this first** if
  you are new to the codebase or debugging a non-trivial issue.

## Runtime systems

- [`guards.md`](./guards.md) — the four enforcement guards (Stall /
  ReAct, Ralph Loop, Side-Effect Guard, Turn Integrity) and the
  Turn Execution Stack.
- [`memory.md`](./memory.md) — the three-layer memory architecture
  (BOOT wings, Memory Palace, knowledge graph) plus embeddings and
  the Context Engine.
- [`single-user-boot.md`](./single-user-boot.md) — why BOOT state is
  single-user and how the `__global__` profile fallback works.

## Operations

- [`troubleshooting.md`](./troubleshooting.md) — symptom → diagnosis →
  fix for the recurring operational issues (daemon lifecycle, Ollama,
  provider errors, tools, STT, vision, multi-agent, updates).

## Repository layout

- [`references.md`](./references.md) — what `_references/` is, what each
  vendored project is for, when to update it, and when to remove it.

## Feature guides

- [`bootstrap-and-core-files.md`](./bootstrap-and-core-files.md) —
  startup BOOT wings, onboarding, and the current memory-layer split.
- [`multi-agent.md`](./multi-agent.md) — delegated worker /
  researcher / verifier agents and profile-scoped sub-sessions.
- [`tool-harness.md`](./tool-harness.md) — tool execution model,
  permission gating, BOOT tools, and Memory Palace behavior.
- [`channels-and-telegram.md`](./channels-and-telegram.md) — Telegram
  session mapping, channel config, and reply flow.
- [`tts.md`](./tts.md) — managed TTS lifecycle, speech generation,
  default voice, and Telegram audio delivery.
- [`stt.md`](./stt.md) — managed STT lifecycle, audio transcription,
  Whisper engines, and automatic Telegram ingestion.
- [`websearch.md`](./websearch.md) — web search modes, SearXNG
  lifecycle, and image-search integration.
- [`slash-commands.md`](./slash-commands.md) — runtime commands
  available in CLI and channel sessions.
- [`model-and-config.md`](./model-and-config.md) — model settings,
  profiles, provider support, and config files.
- [`resolutions.md`](./resolutions.md) — historical resolutions of
  recurring issues and their rationale.

## Conventions

Every doc in this folder follows the same conventions:

- File names are lowercase and hyphenated.
- Cross-references use relative links.
- Operational steps use `bash` fenced blocks.
- "What lives where" questions are answered by the file that owns the
  code (`src/core/runtime/...` → `docs/architecture.md`,
  `src/core/memory/...` → `docs/memory.md`).
- When a doc contradicts the code, the code wins. Open a PR to fix the
  doc.
