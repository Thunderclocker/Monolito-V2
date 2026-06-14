# Contributing

Thanks for working on Monolito V2. This document captures the workflow
and the rules every change should follow. It is short on purpose — most
operational detail lives in [`docs/`](./docs/README.md).

## TL;DR

1. Code lives in **this local checkout**, not on the VPS.
2. Edit → `npm run build` (typecheck) → `npm run check` (smoke-boot
   the CLI) → commit.
3. Push to the user's VPS via `/update` from the Telegram or TUI
   session. The runtime will fetch, fast-forward, and restart.
4. Document in the same commit (or in the immediately following
   commit) so `docs/` and `AGENTS.md` always reflect the current
   code.

---

## The hard rule: never edit files on the VPS

The VPS runs a production install at `~/.monolito/app`. The local
checkout at this repo is the source of truth. Do not patch files
directly on the VPS — every change must come through git.

The reason is operational, not bureaucratic: VPS edits get lost on
the next `/update`, they cannot be reviewed, and they cannot be
reverted cleanly. The install path is:

```
local checkout  →  commit  →  push to GitHub  →  /update on VPS
```

If you need to read a VPS file for diagnostics, use the
`AGENTS.md` "VPS Diagnostics" section. If you need to change a VPS
file's behavior, change the code locally and let `/update` carry
the change.

---

## Development workflow

### Prerequisites

- Node.js 22 or newer.
- `npm` (the lockfile is `package-lock.json`; do not switch to yarn or
  pnpm without coordination).
- A working `~/.monolito/.env` (copy from `.env.example` and fill in
  the provider section).
- Docker, if you intend to test the managed services (STT/TTS/Vision/
  SearXNG/Embeddings).

### Local loop

```bash
# typecheck (no emit)
npm run build

# boot the CLI once to make sure the bin shim is intact
npm run check

# run the daemon in the foreground
npm run daemon

# run the TUI client
npm run cli
```

The CLI auto-spawns the daemon if it is not running, so most of the
time you only need `npm run cli`.

### Testing

Tests live next to the source as `*.test.ts`. They are written for
`node:test` (the built-in runner) and run via the scripts in
`package.json`:

```bash
npm test              # all tests recursively
npm run test:guards   # the four-guard suite + multiverse
npm run test:tools    # tool registry, permissions, config wings
```

Always run `npm run test:guards` before committing. The four-guard
test suite is the canary for regressions in the runtime's
enforcement layer; the multiverse test exercises the worktree
fork-merge path; semantic recovery exercises the vector-backed loop
learning.

If you add a new guard or change the Ralph Loop behavior, add a test.
The four-guard test suite is the canary for regressions in the
runtime's enforcement layer.

### Commit messages

Use Conventional Commits. Scopes in active use:

- `runtime` — orchestration, runtime, model adapter
- `daemon` — process supervisor, IPC, lifecycle
- `orchestrator` — multi-agent, Ralph Loop
- `tools` — tool registry, permissions
- `memory` — boot wings, memory.md, knowledge graph, file storage
- `context` — Context Engine (compaction, recovery)
- `stt` / `tts` / `vision` / `websearch` — managed services
- `channels` — Telegram
- `storage` — fileStorage, markdownMemory, paths
- `docs` — documentation only
- `ci` — CI/CD configuration

Examples:

```
feat(tools): add new SearchDocs tool with SearXNG backend
fix(daemon): handle SIGTERM during self-restart without orphaning socket
refactor(orchestrator): extract Ralph Loop rules into separate module
docs(memory): add embedding cache lifecycle section
```

### Commit hygiene

- One logical change per commit. A fix + a refactor = two commits.
- The agent that makes the change is responsible for the commit. Do
  not batch unrelated work into a "misc" commit.
- Do not commit generated artifacts (`Monolito Repomix.txt`,
  `scratch/`, `node_modules/`, etc.). The `.gitignore`
  covers most of them; if you find a new one, add it.

---

## Code guidelines

These rules are enforced by review. Breaking them is fine if you have
a good reason, but state the reason in the commit body.

### Don't hardcode regexes when semantic is an option

The five assertion rules in the Ralph Loop used to be regex matches.
They are now LLM classifiers. If you find yourself writing a new
regex for "the user said X", ask: is this a semantic classification
that the LLM can do better? If yes, route through
`runBackgroundTextTask` and feed the LLM's JSON output to the rest
of the loop.

### Solve at the structural layer first

Bug fixes should fix the model or the state, not the symptom in
text. Examples:

- ❌ "Add a new prompt line that says 'remember to verify'."
- ✅ "Move the verification into the Side-Effect Guard's required
  prerequisite check."

If a fix has to be in the prompt, the commit body must explain why
the structural option was not viable.

### Tool definitions are Zod schemas

Every new tool in `src/core/tools/registry.ts` must:

- Have a Zod schema for its input.
- Set `sideEffect: true` if and only if the tool mutates the world
  outside the runtime (Telegram send, network call, file deletion,
  etc.). Read-only tools stay `sideEffect: false`.
- Have a clear `description` that includes preconditions when the
  Side-Effect Guard or Ralph Loop depends on them (e.g. *"call
  VisionAnalyze first if you intend to verify the photo"*).
- Emit `tool.start` / `tool.finish` events through the registry, not
  the renderer, so the Ralph Loop and the audit log see it.

### Add a tool only if it cannot be expressed via existing ones

Bash + workspace tools cover most scripting. If you find yourself
adding a tool that just calls a CLI command, consider exposing the
underlying command as a Bash profile permission instead.

### Documentation is part of the change

A change that affects:

- The runtime flow → update [`docs/architecture.md`](./docs/architecture.md)
- A guard or rule → update [`docs/guards.md`](./docs/guards.md)
- Memory → update [`docs/memory.md`](./docs/memory.md)
- The tool catalog → update [`docs/tool-harness.md`](./docs/tool-harness.md) and
  `README.md`'s slash-command list
- The single-user BOOT design → update [`docs/single-user-boot.md`](./docs/single-user-boot.md)
- New failure modes → add a section to [`docs/troubleshooting.md`](./docs/troubleshooting.md)

Documentation in the same commit (or in an immediately following
docs-only commit) is fine. The rule is: by the time the change is
merged, the docs are current.

### No hallucinated configuration

The runtime's `tool_manage_config` is the **only** way to read or
write `CONF_*` JSON config files via `tool_manage_config`. Never hand-edit
`memory/config/` to fake a configuration change — the agent cannot be audited.

### Run the typecheck

`npm run build` must pass before the commit. No exceptions.

---

## Adding a new provider

Provider implementations live under
[`src/core/runtime/providers/`](./src/core/runtime/providers/). To add
a new one:

1. Create `<provider>.ts` exporting
   `callXxxApi(config, system, messages, abortSignal, maxTokens, isSubAgent, allowedToolNames)`
   that returns `ProviderResponse`.
2. Add a `case` for it in
   [`src/core/runtime/providers/index.ts`](./src/core/runtime/providers/index.ts).
3. Add the provider enum to the `modelProfileZod` in
   [`src/core/tools/registry.ts`](./src/core/tools/registry.ts) so it
   is accepted in `tool_manage_config`.
4. Add a `MENU_MODEL_PROVIDER_ORDER` entry in the model menu
   ([`src/apps/cli/tui/modelMenu.ts`](./src/apps/cli/tui/modelMenu.ts))
   so users can pick it.
5. Test with at least one model from the new provider.
6. Document any quirks (auth flow, prompt-caching headers, rate-limit
   behavior) in [`docs/model-and-config.md`](./docs/model-and-config.md).

---

## Adding a new guard

The four guards follow the same design contract. A new guard must:

1. Be a function with a clear input/output contract.
2. Be **fail-safe to approve** (catch all errors and return "no
   violation").
3. Log its rejections to the session worklog with a stable prefix.
4. Honor Level 0 user intent.
5. Have at least one test in `<name>.test.ts`.

If the new guard runs in the same position as an existing one
(pre-turn, mid-turn, post-finalization), document its precedence in
[`docs/guards.md`](./docs/guards.md).

---

## Releasing

Releases follow the standard `MAJOR.MINOR.PATCH` SemVer.

1. Update [`CHANGELOG.md`](./CHANGELOG.md): move the `[Unreleased]`
   section's contents into a dated release entry.
2. Bump the version in [`package.json`](./package.json).
3. `git tag -s vX.Y.Z -m 'vX.Y.Z'`
4. Push: `git push origin main --follow-tags`

The user deploys the new release to the VPS via `/update`. There is
no separate deploy step.

---

## Where to ask

- Architecture questions → [`docs/architecture.md`](./docs/architecture.md)
- Tool questions → [`docs/tool-harness.md`](./docs/tool-harness.md)
- Runtime questions → `AGENTS.md`
- Operational questions → [`docs/troubleshooting.md`](./docs/troubleshooting.md)
