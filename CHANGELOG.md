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

- **`GenerateImage` soporta `provider: "minimax"` con auto-detección**:
  cuando el perfil activo es MiniMax (o el `baseUrl` contiene `minimax`),
  la tool enruta a `https://api.minimax.io/v1/images/generations` con
  modelo `image-01` por default. La API key se reusa del perfil activo
  (la misma del chat) y, si se fuerza el provider con un perfil distinto,
  cae a `MINIMAX_API_KEY` con `ANTHROPIC_AUTH_TOKEN` como fallback.
  Mismo body OpenAI-style que la rama DALL-E. Sin cambios para Grok /
  OpenAI. (`src/core/tools/domains/media.ts`).

### Added (Fase 17-24 — final parity push)

- **Fase 17 — 13 bash security validators restantes**:
  `comment_quote_desync`, `quoted_newline`, `cr_injection`,
  `heredoc_injection`, `suspicious_env_path`, `proc_subst_fd`,
  `fork_bomb`, `shebang_in_arg`, `multi_cd_up`, `chmod_777`,
  `find_exec`, `xargs_dangerous`, `base64_exec`. Brings bash-helpers
  from 12 to 25 validators.
- **Fase 18 — WebFetch validateUrlStrict + HTTPS upgrade**:
  `webfetch-validators.ts` with `validateUrlStrict` (http→https,
  protocol allowlist, length check), `isPrivateHost` (RFC 1918 +
  loopback detection). data: URLs get 1MB limit for tests/dev.
- **Fase 19 — Recency filter WebSearch + Read file history**:
  WebSearch inputSchema adds `recency` enum (day/week/month/year),
  Brave provider translates to `&freshness=`. Read now tracks read
  content via fileHistory.trackEdit for recovery.
- **Fase 20 — Bash async LLM classifier (Haiku-style)**:
  `semantic-classifier.ts` with anthropicHaikuClassifier (real) and
  ollamaClassifier (local), opt-in via
  `MONOLITO_BASH_SEMANTIC_PERMISSIONS=1`. Default stub returns
  "unsure" (deny-by-default). 1h cache TTL.
- **Fase 21 — Settings file validator + similar file suggestion**:
  `file-validators.ts` with `isSettingsFile`,
  `validateSettingsFileContent` (JSON parse),
  `findSimilarFiles` (same-dir ranking), `suggestPathUnderCwd`.
- **Fase 22 — MCP isResultTruncated + isOpenWorld enforcement**:
  `mcp/permissions.ts` with `isMcpPermissionEnabled` (reads
  CONF_POLICY, default-allow). `toolOutputTruncated` checks if
  output exceeds maxResultSizeChars. McpInvokeTool enforces
  isOpenWorld for write tools.
- **Fase 23 — Skill discovery from path**:
  `skill-discovery.ts` with 10 SKILL_PATH_PATTERNS covering TS, JS,
  Python, Markdown, JSON, YAML, Docker, tests, migrations, Bash,
  SQL, docs. Also integrates with listDynamicSkills.
- **Fase 24 — E2E smoke test + docs**:
  `scripts/test-tools-e2e.ts` runs Read→Edit→Bash→Grep sequence
  with MiniMax M3. `docs/security-parity.md` documents parity
  status, 25 security validators, destructive detection,
  permission gate modes, and de-scope decisions.

### Added (Fase 0-16)

- **Fase 8 — Bash AST + permission rules machinery**:
  - `core/tools/domains/bash/parseForSecurity.ts`: shell-quote-based AST
    parser with operator splitting (|, &&, ||, ;, &), env var stripping,
    wrapper detection (env, sudo, nice, nohup, timeout, command),
    per-segment CommandSegment
  - `permissionRules.ts`: matchWildcardPattern, stripAllLeadingEnvVars,
    stripWrappersFromArgv, stripCommentLines (quote-aware), filterRulesByContentsMatchingInput,
    isReadOnlyCommand, BINARY_HIJACK_VARS, hasUnquotedCommandSubstitution
  - `segmentation.ts`: per-segment evaluation, detectCdGitChain (cross-segment
    cd+git suspicion), pipeline aggregation
  - `permissionGate.ts`: integrates AST + rules + segmentation + bashSecurity
    validators + readOnly + path. Returns allow/ask/deny with reason.
    Handles parse-unavailable conservatively. Reads Bash-specific rules
    from policyConfigZod.
  - `outputLimits.ts`: truncateOutput with 30K default (64MB cap), marker,
    persistToFile, looksLikeImageOutput
  - `shouldUseSandbox.ts`: decision logic for sandboxed execution
  - `commandSemantics.ts`: exit code → human-readable interpretation
    (grep/rg/find/diff/cmp/test)
  - Bash tool now wires the full permission gate + output limits + command
    semantics. Result extended with stdoutTruncated, stderrTruncated,
    exitInterpretation, looksLikeBinary fields.
  - Tests: 49 new tests (parseForSecurity, permissionRules, permissionGate)
- **Fase 9 — Bash output limits + command semantics wiring** (see Fase 8)
- **Fase 10 — WebFetch LRU cache + redirect validation + preapproved**:
  - `webfetch.cache.ts`: LRU URL cache (15min TTL, 50MB cap, byte-aware)
    wired into WebFetch with cacheHit field
  - `webfetch.redirect.ts`: isPermittedRedirect (same-host+port+registrable
    domain), followWithPermittedRedirects (MAX_REDIRECTS=10)
  - `webfetch.preapproved.ts`: 20-host curated list (MDN, npm, PyPI,
    GitHub, Stack Overflow, RFC, IETF, man7, etc.) with www-stripping
  - Tests: 14 new tests
- **Fase 11 — MCP dynamic facade + truncation real**:
  - `core/mcp/tool-registry.ts`: per-server tool cache (5min TTL) with
    listMcpTools, clearMcpServerCache
  - McpInvokeTool: dynamic facade (server, tool, arguments), discovers via
    cache, validates via normalizeMcpToolName, invokes via client.callTool,
    applies truncateMcpResult (25K token budget), returns with
    collapseClass classification
  - `mcp-truncation.ts` extended with truncateMcpResult (handles string,
    array, object), proper TRUNCATION_MARKER_PREFIX/SUFFIX split
  - Tests: 6 new tests
- **Fase 12 — Read deep features**:
  - `file/image-processor.ts`: detectImage via magic bytes, extracts
    width/height from PNG/JPEG headers
  - `file/encoding.ts`: detectEncoding (UTF-8/UTF-16/ASCII/Latin-1/binary
    with BOM detection), detectLineEnding (lf/crlf/cr/mixed/none),
    decodeBuffer
  - `file/notebook.ts`: readNotebook parses .ipynb JSON, returns cells
    with index/cell_type/source, extracts kernel/language from metadata
  - `file/pdf.ts`: readPdfText via pdftotext (timeout + maxBuffer fallback),
    page range support
  - read.ts: image (magic bytes), notebook (.ipynb), pdf (.pdf) detection
    before binary/text fallback
  - Output type extended to 'image' | 'notebook' | 'pdf'
- **Fase 13 — Edit multi-edit atómico**:
  - `file-edit-helpers.ts`: applyMultiEditToFile applies array of edits
    atomically (all-or-nothing), validates all first
  - file.ts Edit tool: supports single-edit (old_string/new_string) or
    multi-edit (edits: [...]) modes (mutually exclusive)
- **Fase 14 — Grep configurable**:
  - `grep-extensions.ts`: buildVcsExcludes (configurable VCS dirs),
    clampLineWidth (max_columns truncation), splitGlobPatterns
    (brace-aware comma/whitespace split), sortByMtime
  - Grep tool: inputSchema adds max_columns, sort_by_mtime,
    exclude_vcs_extra
- **Fase 15 — WebSearch filter translation per provider**:
  - `core/websearch/filter-translation.ts`: translateFilters handles brave
    (silent ignore + warning), searxng (site:/ -site: query), serper
    (inline site:), tavily (include_domains/exclude_domains in postBody),
    default (warning)
  - domainFilterValid validates mutual exclusion
  - Tests: 13 new tests

### Added (Fase 0-7)

- **upstream parity tool extensions** — `feat/tools-parity-fase0..fase6`
  brings the 8 shared tools (Bash, Read, Write, Edit, Grep, MCP,
  WebFetch, WebSearch) closer to upstream reference parity.
- **Tool framework extensions** (Fase 0): 9 additive optional
  fields on `ToolDefinition`: `isReadOnly`, `isSearchOrReadCommand`,
  `checkPermissions`, `isMcp`, `isOpenWorld`, `maxResultSizeChars`,
  `isResultTruncated`, `prompt` (async), `toAutoClassifierInput`.
  Backwards compatible.
- **Foundation modules** (Fase 0):
  - `core/tools/file-state.ts` — per-session read state LRU
    (10K cap) with mtime staleness detection.
  - `core/tools/file-history.ts` — snapshot store for rollback
    (TTL 30d, hash-based dedup).
  - `core/tools/secret-scanner.ts` — AWS / GitHub PAT (classic +
    fine-grained) / Slack / PEM / JWT detection + high-entropy
    heuristic. 6 patterns.
  - `core/utils/lru-cache.ts` — byte-aware LRU with TTL utility.
  - `core/tools/permission-runtime.ts` — consumes
    `policyConfigZod`, runs PreToolUse hook chains, default-allow
    (explicit `deny` rule always wins).
- **Read port** (Fase 1) — `core/tools/file/read.ts` with
  streaming fast-path, 256KB cap, device-file guard (`/dev`,
  `/proc`, `/sys`), binary detection (NUL bytes), and
  `readFileState` population. Discriminated output: `text` |
  `file_too_large` | `binary` | `device_file` | `not_found`.
  Mtime staleness exposed via `isFileStale()`.
- **Edit + Write ports** (Fase 2) — `file-edit-helpers.ts` with
  `applyEditToFile` (matchIndex/replaceAll), curly-quote
  normalization, `.ipynb` rejection, `MAX_EDIT_FILE_SIZE` (1 GiB
  cap), `generateUnifiedDiff`. Edit rejects `.ipynb`, runs size
  check, no-op detection, soft mtime-staleness warning via
  readFileState, snapshots prior content to fileHistory, returns
  `structuredPatch`. Write runs secret guard (blocks on
  AWS/GitHub PAT/Slack/PEM/JWT detection), soft pre-read warning,
  snapshots to fileHistory before overwrite.
- **Grep port** (Fase 3) — extended with `-A`/`-B`/`-C`/`context`
  for lines of context, `type` filter (rg `--type`), VCS
  exclusions (`.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`), glob
  comma-split, dual-accept `ignore_case` and `-i`, and `-e pattern`
  for safety against patterns starting with `-`.
- **WebSearch extension** (Fase 4) — `allowed_domains` and
  `blocked_domains` inputSchema fields, mutually exclusive
  validation, upstream parity on Brave silent-ignore semantics.
- **Bash security** (Fase 5) — 12 security validators (subset of
  bashSecurity's 25) covering control chars, IFS injection, mid-word hash,
  brace expansion, backslash escape, unicode whitespace, dangerous
  patterns (curl|sh, wget|bash), shell metachars, dangerous
  redirection (to /etc, /System, ~/.ssh, ~/.bashrc), embedded
  newlines, backslash-escaped operators, and dangerous variables
  (LD_PRELOAD, DYLD_INSERT_LIBRARIES). Critical/high findings
  block execution; low/medium attach as `security_notices`.
  Destructive command detection (10 patterns: rm -rf, git
  reset --hard, git push --force, fork bomb, DROP TABLE,
  kubectl delete, terraform destroy) emits `warning` field but
  does not block. Análisis de seguridad por omission de los 13
  validators NO porteados: comment-quote desync, quoted newlines,
  CR injection específico, heredoc malicioso — documentados.
- **MCP facade** (Fase 6) — `mcp-collapse.ts` classifies MCP tools
  into search/read/write/default with server allowlists for
  Slack/GitHub/Linear/Sentry/Notion/Gmail. `mcp-truncation.ts`
  applies token-budget truncation (chars/4 estimator, 25K token
  default budget). All three MCP tools marked with the new
  bashSecurity-parity flags.

### Security

- `Bash` now blocks commands with critical/high security findings
  (curl|sh, IFS injection, LD_PRELOAD override, etc). Destructive
  commands (rm -rf, git reset --hard, fork bomb) emit a warning
  field but still execute.
- `Write` now runs secret scanner before writing. Leaks of AWS
  access keys, GitHub PATs (classic + fine-grained), Slack tokens,
  PEM private keys, JWTs, and high-entropy strings are blocked.
- `Edit` checks `.ipynb` and rejects edits (notebook tooling
  required).

### Changed

- Read returns discriminated output type (was always returning
  text). Consumers that assumed a flat `{ path, content, ... }`
  shape must check `type` first. Existing flat shape is preserved
  when `type === "text"`.
- `Edit` and `Write` return `warning` field on pre-read concerns
  (soft, non-blocking).
- `Grep` accepts `-i` as alias for `ignore_case` (dual-accept).

- **GitHub Actions CI** (`.github/workflows/ci.yml`): runs `tsc --noEmit`
  + `npm test` on every push and PR. Includes a smoke-test job that
  exercises the agent against MiniMax M3 on `main` branch pushes.
- **Regression tests** for two pre-existing bugs that were fixed in
  earlier commits but had no test coverage:
  - `querySemanticTools` returns `string[]` of tool names (the caller
    in `indexToolsInPalace` was previously treating it as
    `Array<{name: string}>` and accessing `.name` on a string).
  - `listModelTools` returns tools with `inputSchema` (camelCase) — the
    Anthropic Messages API rejects tools with `input_schema` (snake_case)
    silently, which made the agent appear to work but unable to invoke
    any tool.
- **`scripts/test-minimax-m3.ts`** — end-to-end smoke test script:
  cleans `MONOLITO_ROOT`, bootstraps config from env, sends a known
  prompt ("Reply with exactly: PONG"), verifies the response contains
  "PONG", and exits with a structured pass/fail log. Used by the
  smoke-test CI job and by developers after a model change.
- **Smoke-test pattern documented** in the new `scripts/` directory so
  other providers (Anthropic, xAI, OpenAI) can plug in the same shape.

### Changed

- `tools/registry.ts` refactored from a 5037-line monolith into a
  295-line barrel file (`registry.ts`) + 1094-line helpers
  (`internal.ts`) + 14 domain-organized files under
  `tools/domains/` (shell, mcp, web, file, git, telegram, media,
  memory, forensics, delegation, config, todo, admin, skills). To
  add a new tool, create a file in the appropriate domain and add
  the import in the barrel.
- `tsconfig.json` enables `strict: true`. This surfaced 25 latent
  bugs (mostly `T | undefined` not being narrowed before use) that
  were fixed as part of this work.
- Runtime `console.error` calls in `registry.ts`, `runtime.ts`,
  `modelConfig.ts`, `smartCompactor.ts`, `contextSnapshot.ts`, and
  `channelManager.ts` replaced with structured `logger.error(...)`
  calls that include `errorMessage` and `errorStack` metadata. CLI
  files in `apps/cli/` intentionally keep `console.*` for human-
  facing output.
- ~10 `as any` casts in `runtime.ts`, `orchestrator.ts`, and
  `modelAdapter.ts` replaced with structural types (e.g.
  `let turn: { finalText: string; steps?: ... } | null` instead of
  `let turn: any`). The `AgentLoopRecoverableAction` union was
  extended to include `coherence_correction`, `veracity_correction`,
  `commitment_correction`, and `operational_interruption`, which
  removed 4 type-laundering casts in the model adapter.

### Fixed

- **`isDangerousBash`** rewritten with tokenization (not regex) and
  now catches 15+ dangerous verbs plus fork-bomb and `dd` patterns.
  The previous regex missed `curl x.com/y | sh` and several other
  bypass vectors.
- **`SKILL_THREAT_PATTERNS`** regexes tightened: now matches
  `rm -fr`, `rm -Rf`, all shells (`bash`, `zsh`, `ksh`, `csh`,
  `fish`), and absolute paths to dangerous system files
  (`/etc/passwd`, `/etc/shadow`, `/etc/sudoers`, `/boot/`). Added
  protection against `>` / `<` redirects to device files.
- **`MIN_ATTEMPTS_BEFORE_RENEWAL`** raised from `1` to `3` in
  `decideRenewal`. The previous value meant sub-agents were eligible
  for renewal after a single attempt, with no signal of whether
  they were making real progress.
- **`bootstrapConfigFromEnv`** added to `modelConfig.ts`: reads
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
  and `MONOLITO_ACTIVE_PROVIDER` from env and persists them to the
  SQLite config wings, enabling the agent to run with environment-
  variable-supplied credentials (useful for Docker, CI, and
  temporary key rotation).
- **Daemon Unix socket** now uses `chmod 0o600` (owner read/write
  only) instead of the default `0o755`. This prevents local users
  on a multi-tenant host from connecting to the agent.
- **`install.sh`** no longer auto-installs Node.js via
  `curl | sudo bash` from the NodeSource CDN. The installer now
  requires the user to have Node 22+ already installed; this
  removes a supply-chain risk and a project rule violation (the
  project's own `SKILL_THREAT_PATTERNS` blocked this exact
  pattern).
- **Pre-existing bug in `indexToolsInPalace`**: the dynamic skills
  indexing loop accessed `existing[0].name` on a `string[]` value
  (since `querySemanticTools` returns `string[]`, not
  `Array<{name: string}>`). The condition was always false, meaning
  every dynamic skill was re-indexed on every call. Now checks
  `existing[0] === skill.name`.
- **Pre-existing dead code in `orchestrator.ts` worker monitor**:
  the comparison `fullJob.status === "killed"` was checked against
  an enum (`WorkerJobStatus`) that does not include `"killed"`
  (that status only exists in `BackgroundTask` and IPC event
  types). The check was always false. Removed; the actual
  worker_jobs terminal states are `completed` and `failed`.

### Security

- The `install.sh` change above is the primary security fix. The
  `isDangerousBash` and `SKILL_THREAT_PATTERNS` changes are also
  defensive-in-depth — they reduce the blast radius if a model
  ever emits a malicious-looking command.

---


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
  in place. Matches upstream reference's CLI style. The one-shot
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
