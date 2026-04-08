# Monolito v2

Clean extraction of the Monolito v1 operational core.

Included:

- daemon
- CLI terminal client
- session handling and resume
- runtime loop
- slash-command routing
- tool registry and executor
- event-driven tool-use renderer
- persisted model settings
- basic MCP bridge

Excluded on purpose:

- inherited `free-code` entrypoint and UI tree
- memory
- hooks
- skills
- subagents
- tier 2 tools
- branding and extra UX baggage

## Run

```bash
npm run daemon
npm run cli
```

## Quick checks

```bash
npm run cli -- /status
npm run cli -- -p '/tool pwd'
npm run cli -- -p '/mcp resources demo'
```

## Notes

- Settings: `~/.monolito-v2/settings.json`
- Session data: `.monolito-v2/` relative to the project root (created on first daemon start)
- Legacy v1 settings fallback: `~/.monolito/settings.json`
