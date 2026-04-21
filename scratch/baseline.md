Baseline captured on 2026-04-21.

`npm run check`:

```text
> monolito-v2@0.2.0 check
> node --experimental-strip-types src/apps/cli.ts --help

monolito [sessions|resume <id>|logs <id>|status <id>|history <id> [limit]|-p <prompt>]
Without arguments, opens the Monolito terminal client and starts the daemon if needed.
```

`wc -l src/core/runtime/modelAdapter.ts`:

```text
2878 src/core/runtime/modelAdapter.ts
```

`node --experimental-strip-types src/apps/cli.ts /status`:

```text
you /status
assistant Session: Test Workflow Session (test-session-1776478713298)
State: running
Profile: default
Messages: 1
Created: 2026-04-18T02:18:33.299Z
Updated: 2026-04-21T20:16:05.476Z

Model:
  Protocol: anthropic_compatible
  Base URL: (default)
  Model: (default)
  API Key: Not set
  Timeout: 3000000ms

Tools: 54 available
2ms · tokens: n/d
```

Daemon note:

```text
monolitod-v2 already running
pid: 39293
log: /home/cristian/.monolito-v2/logs/monolitod.log
lock: /home/cristian/.monolito-v2/run/daemon-lock.json
```
