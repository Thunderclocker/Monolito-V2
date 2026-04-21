Refactor report captured on 2026-04-21.

Summary

- Replaced the legacy `src/core/runtime/modelAdapter.ts` (2878 lines) with `src/core/runtime/modelAdapterLite.ts` (509 lines).
- Switched `runtime.ts` and `memoryAgent.ts` to the new adapter.
- Removed phrase-based surrender detection from `src/core/runtime/orchestrator.ts`.
- Deleted dead runtime files: `modelAdapter.ts`, `modelAdapter.test.ts`, `directiveParser.ts`, `recoveryPolicy.ts`, `coordinatorPrompt.ts`.

Lines before/after

- `src/core/runtime/modelAdapter.ts`: 2878
- `src/core/runtime/modelAdapterLite.ts`: 509

What was verified

- `npm install`
- `npm run check`
- `node --experimental-strip-types src/apps/cli.ts /status`
- `node --experimental-strip-types src/apps/cli.ts -p '/tool pwd'`
- One real prompt with model/tool execution: `¿Qué hora es?`
- Background worker path:
  - delegated a long-running background task
  - observed `delegate_background_task` tool execution
  - observed parent-session `<task-notification>` in session logs
  - resumed the same session and retrieved the worker result with `Mostrame el resultado del worker.`

Known issues / pending

- `modelAdapterLite.ts` is still above the target size cap: 509 lines vs target <= 400.
- In the interactive UI, sending the second turn immediately after the delegation acknowledgement produced a transient `Session ... is already busy with another running turn.` message once. Session logs show the worker notification arrived and the follow-up turn still completed, but the UX race is not fully eliminated.
- The prompt/tool validation shown by the UI for `delegate_background_task` still exposes the key names before the natural-language reply. That behavior existed in the tool renderer path and was not changed here.

What was not tested

- Anthropic-native provider path with the official SDK against a live Anthropic-compatible endpoint.
- Ollama provider path.
- MiniMax XML fallback path (`directiveParser` was intentionally not reintroduced).
- `/mcp resources demo`, `/tts status`, `/stt status`.
- Memory persistence across daemon restart (`recordá ...` / restart / recall).
