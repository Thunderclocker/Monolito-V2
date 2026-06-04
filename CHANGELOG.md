# Changelog

All notable changes to Monolito V2 are recorded here. Newest releases are
on top. Dates are in the user's local timezone (America/Argentina/Cordoba,
UTC-3).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
SemVer is used: `MAJOR.MINOR.PATCH` where `MINOR` increments on user-visible
additions and `PATCH` on fixes that do not change behavior.

---

## [Unreleased]

### Added

- Dynamic semantic RAG context that pulls semantically related Palace
  facts into the prompt, with an isolated context-tags guard to prevent
  cross-session leakage.
- Vector-backed loop learning via `querySimilarErrors` for hot
  error-resolution memory.
- Branch-and-merge multiverse mode: parallel sub-agents can run in
  isolated git worktrees and fast-forward-merge their branches back.
- Adult search-engine support in SearXNG (`pornhub`, `redtube`, `rule34`)
  with dynamic `safesearch=0` toggling tied to the session's adult mode.
- `GenerateImage` core tool with automatic xAI Grok and OpenAI support.
- `schedule_task` unified tool for reminders and cron jobs.
- Dynamic `RalphRule` table populated by MemoryAgent and enforced at
  finalization (semantic LLM classifier, not regex).
- `CONF_HEARTBEAT` wing with `enabled`, `min_idle_minutes`,
  `interval_minutes` configuration.
- **EVIDENCE-FIRST RULE** (`dbb756c`) in the orchestrator system prompt:
  when the user asks to enumerate, list, count, or inventory the current
  state of a dynamic system resource (skills, sessions, files, channels,
  processes, tools, configs), the assistant must execute the appropriate
  tool first and answer with the result — never from memory with a
  disclaimer. Backed by a new `enumerate_dynamic_state` Ralph rule that
  fires the corrective message if the assistant still answers from memory.

### Changed

- TUI tool-call display now mutates the in-flight `tool.start` block
  when the tool returns, so each tool call renders as a single bullet
  (rose) instead of the previous two-bullet pattern (`● …` rose + `● …`
  green). The `done`/`error` label is dropped; only the text changes
  in place. Matches Claude Code's CLI style. The one-shot
  `ToolUseRenderer` (used in non-interactive logs) keeps its
  `done`/`error` label and color.
- `monolito` CLI is now a `node --experimental-strip-types` shim; no
  compilation step.
- All configuration moves from `~/.monolito.json` to SQLite `CONF_*`
  wings, edited exclusively via `tool_manage_config`.
- Memory layout collapses identity + rules into a single
  `palace_nodes` table under the `BOOT_WING` namespace.
- `compactSession` (destructive) is replaced by the Context Engine's
  3-layer anti-amnesia cascade.

### Fixed

- **`enumerate_dynamic_state` Ralph rule `requiredTools` was hardcoded to
  `["ListSkills"]`** but the rule covers many resources (files, channels,
  processes, configs, profiles, models), each mapping to a different tool.
  A user asking to "list files" would trigger the rule, but the verification
  would only pass if `ListSkills` had been called — false positives on
  legitimate `Read`/`Glob`/`Bash` invocations. The rule is now kept as
  documentation with an empty `requiredTools` list (orchestrator skips it),
  and enforcement relies on the EVIDENCE-FIRST RULE in the system prompt.
- **Duplicate `checkTurnIntegrity` invocation in `runAgentLoop`**: a
  fire-and-forget call after every tool-using turn wasted an LLM call and
  only logged `broken_promise` to the worklog, while the synchronous check
  earlier in the loop already enforced both veracity and commitment.
  Removed the duplicate.
- **README claimed `nomic-embed-text` for embeddings**, contradicting the
  actual `bge-m3` model used by `src/core/session/embeddings.ts`,
  `src/core/session/store.ts`, `docs/architecture.md`, `docs/memory.md`
  and `.env.example`. README now correctly says `bge-m3`.
- **Coherence Guard language-agnostic** (`coherenceGuard.ts`): the LLM-judge
  prompt was rewritten in English with examples covering Spanish, English,
  and other languages. The judge now reasons semantically (not by Spanish
  keyword) over patterns like "deferred decision to the user", "success
  report without tool evidence", "sub-agent asking for escalation", and
  "report framing unchanged state as positive outcome when the user asked
  for a state change".
- **Verified-tag cap per session** (`orchestrator.ts`): the
  `<verified>SUCCESS</verified>` tag can now be emitted at most 2 times
  per session. On the 3rd emission, the Ralph Loop forces a terminal
  failure and emits a snapshot for forensic review. Stops the pattern of
  agents re-stamping the tag without doing new work.
- **No-op success claim rejected** (`orchestrator.ts`): if a worker
  emits the verification tag without ANY successful `tool.finish` event
  in the recent turn, the Ralph Loop rejects it as a no-op success claim
  and forces a real tool execution. Catches the "INTACTO / done" pattern
  where the agent reports work that was never done.
- **Coherence Guard bypass is now visible and once-per-turn**
  (`modelAdapter.ts`): the bypass threshold dropped from 3 to 2
  consecutive rejections, and the bypass now injects a visible warning
  block to the user (`COHERENCE GUARD BYPASS WARNING`) and an explicit
  `COHERENCE_GUARD_BYPASSED:VISIBLE` worklog entry. Stops silent
  fallback abuse.
- **Sub-agent insufficient-tools handling** (`modelAdapter.ts`): the
  sub-agent system prompt now instructs workers to report
  `TASK_FAILED:INSUFFICIENT_TOOLS` instead of asking for delegation,
  exiting with fake success, or emitting the verification tag after
  declaring failure. Language-agnostic examples in the prompt.
- **Failed-tools block in dynamic context** (`modelAdapter.ts`): a new
  helper `getRecentFailedToolNames` collects the set of tools that
  produced `ok=false` events in the session and injects them into the
  system prompt so the agent does not propose plans that depend on
  known-broken tools. The block is structural (uses runtime-defined tool
  names) and language-agnostic.
- **Side-Effect Guard Level 0 override is now LLM-judged**
  (`sideEffectGuard.ts`): the hardcoded Spanish/English keyword regex
  (`enviá|forzá|ignorá|skip|salteá`) was removed. The bypass is now
  decided by the LLM-judge, which evaluates whether the user's current
  message contains an explicit, contextual, imperative-form override of
  the pending tool's prerequisite. Past, hypothetical, or third-party
  references do NOT count as overrides. The new `level0OverrideDetected`
  field on the result allows the caller to log every Level 0 bypass to
  the worklog for auditability.

---

## [0.2.0] — 2026-06-03

### Added

- **Turn Integrity Guard** (`cb166ed`) that unifies commitment and
  veracity checks into a single LLM call replacing the standalone
  `veracityGuard`.
- **Semantic veracity guard** (`9f79ec8`) to prevent the LLM from
  claiming executions it did not perform.
- **STT Whisper container deployment optimization** (`19ae1be`):
  extended timeout + Telegram progress notification to prevent the
  user from thinking the request was lost.
- **Systemd self-restart robustness** (`274b6d7`): the restart path
  now handles "active but disabled" service states by checking
  `is-active` and `is-enabled` separately and falling back to a direct
  `sh` spawn when both fail.
- **`<slash-reply>` tags** (`ffca4a0`) that isolate slash-command
  responses from the LLM context, preventing slash output from
  polluting the next turn.
- **Scope boundary between SkillsAgent and MemoryAgent** (`c9e6d96`):
  SkillsAgent creates procedural SOPs only; MemoryAgent handles
  cognitive directives and user preferences. Skills are now declarative
  Markdown, not executable Bash (commit `d093484`).
- **Full tool access model** (`8fb117c`): semantic pre-filtering of the
  tool catalog is disabled; all active tools are exposed to the LLM on
  every call. Dynamic indexing is preserved for meta-queries.
- **Dynamic skill synthesis via SkillsAgent** (`d093484`): skills are
  declarative SOPs discovered through `skill_view` instead of
  executable scripts.
- **Keyword-based full history search** (`187eba2`) and expanded
  limits in `SessionForensics`.
- **Autonomous execution enforcement in Coherence Guard** (`3f90df7`):
  the guard now rejects replies that delegate shell commands to the
  user when the assistant has the tools to do it itself.
- **Granular `get`/`set`/`activate_model` actions in
  `tool_manage_config`** (`8a6ef08`) for surgical configuration edits.
- **Brave, Serper, and Tavily cloud search providers** (`8aecc64`) in
  `WebSearch` and `ImageSearch` alongside the existing SearXNG backend.
- **Human-in-the-loop operational interruption** (`db3302d`): the
  runtime can pause a long-running turn and surface a `permission.request`
  event for user decisions.
- **Telegram cache bypass** and **search retries** (`db3302d`).
- **Grok OAuth dynamic token refresh** (`5df051f`): token cache moved
  under `MONOLITO_ROOT` and resolved at runtime via
  `resolveGrokAccessToken`.

### Fixed

- **Unsafe `INSERT OR REPLACE` on `vec_drawers`** (`fff2f6a`,
  `609e4a3`): replaced with a transactional `DELETE` + `INSERT` to
  avoid UNIQUE constraint failures on the vector table.
- **Daemon systemd path-with-spaces** (`e0f28ad`): the systemd unit
  ExecStart is now wrapped in `/bin/sh -c '...'` so paths with spaces
  resolve correctly.
- **`runUpdate` PATH** (`2193ea9`): the node binary directory is
  prepended to PATH inside the update helper script.
- **Turn finalization hang and Side-Effect Guard false alarm**
  (`c9ff2de`): the guard's LLM judge prompt was tightened to avoid
  rejecting legitimate Telegram sends.
- **RAG amnesia drift and role alternation** (`bd7ece3`): semantic
  recall no longer lets the same `assistant` text appear twice in the
  prompt, and protected zones in compaction are tighter.
- **Dynamic Ralph rules bypass** (`f24d3c1`, `dfe44df`): the
  orchestrator now respects Level 0 user intent by dynamically
  bypassing rules when the user message contains negations
  (*"sin verificar"*, *"no me importa"*).
- **MemoryAgent absolute-constraint synthesis** (`ebf9b6f`): the
  silent memory agent is forbidden from writing rules that would
  override Level 0 user intent.
- **Ollama NaN recovery** (`3764216`): vector normalization handles
  zero-magnitude vectors without producing NaN.
- **WebSearch settings.yml regeneration** (`37673b6`): the managed
  SearXNG is re-deployed when its settings change.
- **Image-search safesearch depends on adult mode** (`31ce694`):
  SearXNG queries include `safesearch=0` only when the session has
  `/adult` on.
- **`AnalyzeImage` and `VisionAnalyze` pinned in `CORE_TOOLS`**
  (`334332e`): the semantic router always exposes them so the Ralph
  Loop can complete the image-verification path.
- **Vector unit normalization + RAG distance threshold** (`f296ab1`).
- **Coherence Guard circuit breaker** (`ae8cd7c`): the guard no
  longer hangs the daemon when sqlite-vec is unhealthy.
- **BOOT wing whitelist hardening** (`170d258`): profile duplicates
  are resolved, and the wing whitelist rejects malformed names
  earlier.

### Changed

- **Unified `install.sh` and `uninstall.sh`** at the repo root
  (`1e8cab1`, `2c0fe8e`): the install script is now interactive and
  creates the production layout in `~/.monolito/app/`. Aborts if a
  nested clone is detected.
- **Systemd restart uses `systemd-run` to escape cgroup**
  (`92a1534`): when the service is managed by systemd, the new
  daemon is spawned via `systemd-run` so it survives the parent
  service cgroup teardown.
- **Dynamic skills are declarative SOPs** (`d093484`): no more
  executable Bash scripts in the skill table.
- **`ModelAdapterLite` renamed to `modelAdapter`** (`aadc489`): the
  interim "Lite" naming was removed once the feature parity with
  the previous adapter was reached.

---

## [0.1.x] — pre-2026-06-02 (initial 0.2 lineage)

The 0.1.x line established the foundational architecture:

- Daemon + CLI client with Unix-socket IPC.
- SQLite-backed runtime for sessions, worklog, events, BOOT wings,
  Memory Palace, and the temporal knowledge graph.
- Multi-agent orchestration with worker spawning and Git worktree
  isolation.
- Tool harness for shell, MCP, Telegram, file access, BOOT access,
  memory filing/recall, and knowledge-graph tools.
- OpenAI-compatible TTS, managed Whisper STT, managed Ollama vision.
- Slash-command interface for runtime inspection and control.
- Telegram channel ingestion with `telegram-<chatId>` session mapping.
- SearXNG-backed web search with dynamic mode switching.
- Provider recovery state machine for 429, 503, 529, 401, 403, and
  `ContextOverflowError`.
- Anthropic prompt caching with the `=== DYNAMIC CONTEXT ===` block
  layout.
