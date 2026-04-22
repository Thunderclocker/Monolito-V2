Open issues after refactor:

1. The interactive "second turn immediately after delegation" path still showed a transient busy-session error once, even though logs confirm the worker notification arrived and the follow-up turn completed afterward.
