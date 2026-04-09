# Bootstrap And Core Files

Monolito uses an OpenClaw-style workspace bootstrap. Core files are injected into the model prompt so the assistant starts with durable workspace context without needing to re-open those files with tools.

## Core files

Each profile workspace is initialized with files such as:

- `SOUL.md`
- `AGENTS.md`
- `IDENTITY.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`
- `MEMORY.md`

These files live under:

`.monolito-v2/profiles/<profile-id>/workspace/`

## First run ritual

If `BOOTSTRAP.md` is still unresolved, Monolito enters onboarding mode instead of normal long-form assistance.

The expected behavior is:

- greet briefly
- ask one short onboarding question at a time
- learn agent identity and user profile
- persist confirmed details into the appropriate core files
- clear or finalize `BOOTSTRAP.md` when onboarding is complete

## Injection behavior

Monolito auto-injects core workspace files into the prompt as bootstrap context.

Important details:

- main sessions can auto-load `MEMORY.md`
- background agent sessions are isolated more tightly
- bootstrap content is capped so it does not explode the prompt
- the agent is told to treat injected files as already-loaded context, not files it must re-read with tools

## Session startup

Starting a fresh session with `/new` resets the session state and triggers a startup sequence so the agent re-reads its core persona and greets again.

If bootstrap is still pending, the startup flow prioritizes onboarding instead.
