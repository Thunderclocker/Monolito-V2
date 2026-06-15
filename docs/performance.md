# Performance

Monolito V2 tracks turn latency in the session worklog:

| Marker | Meaning |
|--------|---------|
| `TURN_PREP:` | Time to build git/workspace context before the first model call |
| `FIRST_TOKEN:` | Time from `model_invoke_start` to the first streamed token |

## Bench script

```bash
node --experimental-strip-types scripts/bench-turn-latency.ts "hola"
```

Requires a configured daemon/model. Reads notes from `memory/sessions/orchestrator/worklog.jsonl`.

## Implemented optimizations (2026-06)

- **Provider streaming**: Anthropic, OpenAI-compatible, and Ollama emit token deltas through `callProviderStream`.
- **CLI incremental render**: `model.stream` updates `composer.streamingText` with 50ms redraw throttle.
- **Telegram live edits**: `TelegramStreamDelivery` uses debounced `editMessageText` during generation.
- **Turn-prep cache**: boot block (`getCachedBootBlock`) and git context (`getGitContextCached`) with mtime invalidation; background prefetch after successful turns.
- **HTTP pooling**: `pooledFetch` reuses keep-alive connections per API origin.
- **Tool schema memoization**: `buildToolDefinitions` cached per turn signature.
- **Path-aware tool waves**: `planToolExecutionWaves` parallelizes disjoint Read/Grep/Edit/Write batches safely.
