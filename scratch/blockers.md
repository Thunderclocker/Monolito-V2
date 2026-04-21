Open issues after refactor:

1. `src/core/runtime/modelAdapterLite.ts` is 509 lines, so it misses the <= 400 target from the plan.
2. The interactive "second turn immediately after delegation" path still showed a transient busy-session error once, even though logs confirm the worker notification arrived and the follow-up turn completed afterward.
