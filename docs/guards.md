# Guards

Monolito V2's defining feature is the four-guards enforcement loop. Without
them, a long-running autonomous agent will lie, forget, derive work to the
user, and break side-effects without realizing. The guards are the reason
this runtime does not hallucinate executions.

All four guards follow the same design contract:

1. They are **last-line auditors**, not primary logic. The agent still does
   the work; the guards only check the result.
2. They **fail-safe to approve**. If the LLM judge errors out, the runtime
   continues. Continuity beats strictness.
3. They **log every rejection** to the session worklog with a stable prefix
   (`COHERENCE_GUARD_REJECTED`, `VERACITY_GUARD_REJECTED`, `SIDE_EFFECT_GUARD_BLOCKED`,
   `BROKEN_PROMISE`) so post-mortem is grep-able.
4. They share a **Level 0 supremacy rule**: a direct, explicit user instruction
   in the current turn always overrides any guard decision.

| Guard | Triggered on        | Catches                                              | File                                           |
|-------|---------------------|------------------------------------------------------|------------------------------------------------|
| 1     | Before each turn    | Stalls, repeated errors, TDD failures                | `runtime/orchestrator.ts` (Stall / ReAct)      |
| 2     | Mid-turn            | Premature finalization, missing verification tag     | `runtime/orchestrator.ts` (Ralph Loop)         |
| 3     | Pre-execution       | Side-effect tool calls without prerequisite          | `runtime/sideEffectGuard.ts` + `turnExecutionStack.ts` |
| 4     | Post-finalization   | Falsified execution, broken promises, profile contradictions | `runtime/veracityGuard.ts` + `runtime/coherenceGuard.ts` |

Plus a single coordinator: the **Turn Integrity Guard** that unifies the
veracity and broken-promise checks into one semantic LLM call.

---

## 0. The Level 0 supremacy rule

Every guard that consults memory or user preferences applies the same
override:

> If the user's most recent message contains an explicit, semantically
> clear instruction to skip, bypass, ignore, or perform a task without a
> specific step (e.g. *"sin verificar"*, *"no me importa, mandá"*, *"skip
> verification"*, *"force send"*), the user wins. Always.

This rule is implemented in two places:

- **Side-Effect Guard** — see the `REGLA FUNDAMENTAL` block in
  [`src/core/runtime/sideEffectGuard.ts`](../src/core/runtime/sideEffectGuard.ts).
  There is also a hard regex bypass for words like
  `enviá de todos modos`, `forzá`, `ignorá`, `skip`, `salteá`.
- **Dynamic Ralph rules** — see `checkDynamicRalphRules` in
  [`src/core/runtime/orchestrator.ts`](../src/core/runtime/orchestrator.ts).
  The LLM judge is prompted to set `explicitBypass=true` when the user's
  intent clearly negates the rule.

The reason for this rule is operational: if the user knows what they want,
no amount of saved memory should override them. Profile preferences and
Palace memories are advisory; the current turn's user message is supreme.

---

## 1. Stall / ReAct finalization guard (pre-turn)

**When:** before the runtime admits a sub-agent's final reply.

**What it checks:**

- *Stall detection* — if the same tool call returned the same error twice in a
  row, inject a `STALL_DETECTED` system alert that asks the agent to either
  try a logically distinct path or yield control back to the user with a
  summary of what failed.
- *TDD ReAct* — if the last tool call was a test/build command that exited
  non-zero, reject the finalization with a prompt that demands the test pass
  before the agent is allowed to stop.

**Source:** `e4f97b3 feat(react-guards)` commit and
[`src/core/runtime/orchestrator.ts`](../src/core/runtime/orchestrator.ts).

**Fail-safe:** if the check itself fails, the agent is allowed to proceed.

---

## 2. Ralph Loop (pre-finalization)

The most important guard. Lives inside the orchestrator's turn loop. Every
time a sub-agent tries to finalize, the orchestrator runs the following
checks in order. If **any** fails, the agent receives a re-prompt with the
exact alert message and is forced to keep working.

### 2.1. Verification tag

The agent's final message must end with
`<verified>SUCCESS</verified>`. This is a hard requirement, not a heuristic.

```
[Ralph Loop] SYSTEM ALERT
Intentaste finalizar sin incluir <verified>SUCCESS</verified>.
No podes cerrar la tarea todavía. …
```

### 2.2. Unfinished tasks

The agent's `active_tasks` row in the Palace must have no pending or
in-progress items. Pending tasks are queried via `listSessionTasks`.

### 2.3. Failing bash command

If the last `Bash` tool event in the session has `exitCode !== 0`, the
agent is told the verification failed and asked to fix it before stopping.

### 2.4. The five assertion rules (LLM-driven, not regex)

These are the rules the runtime enforces to prevent the agent from claiming
to have done something it did not. They used to be regex matches; they are
now semantic LLM classifications (see commit `5c30d5d`). The five:

| Rule                      | Claim the LLM looks for                                       | Required `tool.finish` events                          |
|---------------------------|---------------------------------------------------------------|--------------------------------------------------------|
| `send_telegram_photo`     | *"ahí van las fotos"*, *"te envié la imagen"*, etc.            | `TelegramSendPhoto` or `TelegramSendDocument` ok       |
| `send_telegram_file`      | *"te paso el documento"*, *"adjunto el zip"*, etc.             | `TelegramSendDocument` or `TelegramSendPhoto` ok       |
| `send_telegram_msg`       | *"te mandé un mensaje"*, *"ahí te aviso"*, etc.               | any `TelegramSend*` ok                                 |
| `modify_workspace_files`  | *"guardé en…"*, *"creé el archivo…"*, *"modifiqué…"*           | any of `Write` / `Edit` / `MultiEdit` / `Bash` ok      |
| `search_web`              | *"busqué en la web"*, *"investigué en internet"*, etc.         | `WebSearch` / `WebFetch` / `ImageSearch` ok            |

The LLM judge receives the agent's reply plus the list of `tool.finish`
events from the last 80 events of the session and returns strict JSON
`{send_telegram_photo: bool, send_telegram_file: bool, ...}`. If the agent
claims X but no event proves X, the agent is re-prompted with the specific
system alert.

### 2.5. Dynamic Ralph rules

Beyond the five hardcoded rules, the runtime supports a table of
**dynamic rules** stored as `RalphRule` rows in the Palace. Each rule has:

- `name` — human-readable label
- `description` — natural-language intent of the rule
- `requiredTools` — list of tool names that must run successfully
- `errorMessage` — exact prompt to inject on failure

For each dynamic rule, the orchestrator:

1. Asks an LLM judge whether the current turn's intent matches the rule
   (with a regex fallback).
2. Asks the same LLM judge whether the user is explicitly bypassing the
   rule (Level 0 supremacy). If yes, skip.
3. Otherwise, looks at the last 80 events and confirms at least one
   `tool.finish` with `ok=true` for any tool in `requiredTools`.
4. On failure, appends a worklog entry and re-prompts the agent with the
   rule's `errorMessage`.

MemoryAgent creates these rules from natural language in user chat. They
are how *"siempre verifica las fotos con VisionAnalyze antes de mandarlas
por Telegram"* gets enforced at runtime without any code change.

**Fail-safe:** every check inside the Ralph Loop has a regex fallback for
the LLM judge and a try/catch around the LLM call that admits the agent
on error.

---

## 3. Side-Effect Guard (pre-execution, transactional)

The Side-Effect Guard works together with the **Turn Execution Stack
(TES)**, a transactional buffer that defers all irreversible side-effect
tool calls until the orchestrator has approved them.

### 3.1. How a side-effect tool call flows

1. The model emits a tool call with `sideEffect: true` in its definition
   (e.g. `TelegramSendPhoto`, `Bash` with `rm -rf`, anything that mutates
   the world outside the runtime).
2. `runAgentLoop` intercepts the call before execution. Instead of running
   it, the runtime pushes it onto the `TurnExecutionStack` and returns a
   fake result `{buffered: true, index}` to the model.
3. Normal tool calls (read-only) execute immediately and call
   `recordSuccess(toolName)` on the TES.
4. Before the model can take its next action, the orchestrator calls
   `checkSideEffects(rootDir, pendingTools, executedTools, profileId, lastUserMessage, runBackgroundTextTask)`.
5. The guard:
   - Applies the **hard override regex** (instant approval on
     `enviá de todos modos`, `forzá`, `ignorá`, `skip`, `salteá`).
   - Reads `BOOT_USER` for the active profile.
   - Recalls up to 3 semantically related Palace memories.
   - Asks an LLM judge with strict JSON `{approved, reason}` whether the
     pending calls are coherent with the user's profile + memories + the
     last message and whether any required prerequisite (e.g.
     `VisionAnalyze` before `TelegramSendPhoto`) is missing.
   - Respects Level 0 supremacy.
6. If approved: run all buffered calls in order, replace their placeholders
   with real outputs.
7. If rejected: do not run, replace the placeholder with a synthetic error
   describing the reason, and append a `SIDE_EFFECT_GUARD_BLOCKED` worklog
   entry.

### 3.2. Why the TES exists

Without the buffer, the model could fire `TelegramSendPhoto` immediately
and only learn from the user reaction. With the buffer, the runtime
gets a synchronous veto point between the model's intent and the
external world. That makes *"don't send without verifying"* enforceable.

### 3.3. Fail-safe

If the LLM judge errors, the guard returns `{approved: true}`. Continuity
beats strictness — better to send than to silently strand the user.

---

## 4. Turn Integrity Guard (post-finalization, unified)

**Source:** commits `cb166ed` and `9f79ec8`. Replaced the standalone
`veracityGuard` with a single function `checkTurnIntegrity` that runs
two checks in one LLM call.

### 4.1. The two checks

```
1. hasBrokenPromise
   The model made a verbal promise of a future / deferred action
   (e.g. "te aviso en 5 min", "lo reviso luego", "I'll let you know")
   without scheduling a background task to back it up.

2. hasFalsifiedExecution
   The model claimed to have executed a system command, run a script,
   created / modified a file, or transferred data, in the current turn,
   but no matching tool call actually happened.
```

The judge receives the model's final text and the list of `tool.finish`
events from the current turn. It returns strict JSON.

**Improvements (2026-06-11):**
- `parseAuditorJson` now cleans common LLM output issues (single quotes,
  unquoted keys, trailing commas) before giving up.
- Added `parseAuditorJsonByRegex` — a code-level regex fallback that
  extracts boolean flags from raw text even when the JSON is completely
  malformed (prose, truncated, wrapped in natural language).
- Increased auditor `maxTokens` from 160 to 300 to reduce truncation.
- The regex fallback activates silently before the fail-safe path,
  reducing `VERACITY_GUARD_UNVERIFIED` noise without affecting security.

### 4.2. Dispositions

| Check                  | Result         | Runtime action                                  |
|------------------------|----------------|-------------------------------------------------|
| `hasFalsifiedExecution` | true           | Reject; log `VERACITY_GUARD_REJECTED`           |
| `hasBrokenPromise`     | true           | Reject; log `BROKEN_PROMISE`                    |
| Both false             | —              | Approve, continue                               |
| Regex fallback         | —              | Extract flags from raw text (no LLM re-query)  |
| LLM error              | —              | Approve (fail-safe)                              |

A "rejection" in the post-finalization guard is handled differently from
a Ralph Loop rejection: it appends a worklog note and a follow-up prompt
asking the model to correct itself in its next turn. The user still sees
the original (rejected) reply with the guard note attached.

---

## 5. Coherence Guard (post-finalization, profile-level)

**Source:** `src/core/runtime/coherenceGuard.ts`.

The Coherence Guard is the only guard that **rejects answers outright**,
not just appends notes. It runs as a last-stage auditor and asks: *does
the agent's reply contradict the user's profile or stored Palace facts?*

The LLM judge receives:

- `BOOT_USER` for the active profile (the deterministic filter)
- Up to 3 semantically related Palace memories (the dynamic filter)
- The last few turns of recent chat (for context-window awareness)
- The model's final reply

It returns `{coherent: bool, reason: string}`. On `coherent=false`:

- The reply is suppressed and a corrected re-prompt is sent.
- A `COHERENCE_GUARD_REJECTED` worklog entry is appended.
- The user sees the agent's re-prompted response, not the rejected one.

### 5.1. The autonomy clause

Coherence Guard has one special rule: any reply that **delegates manual
work to the user** when the agent has the tools to do it itself is
incoherent. The judge is explicitly told:

> *If the proposed response asks the user to run shell commands, paste
> results, ssh into a server, or otherwise perform tasks the assistant
> could orchestrate via its own tools, mark the response as INCOHERENT.*

This is the technical reason Cristian's rule *"no derivar trabajo
automático al usuario"* is enforced at runtime. The guard reads the
profile preference and the LLM judge enforces it semantically.

### 5.2. The conditional-preference clause

Profile preferences can be conditional (*"if I send a photo, respond
only with a literal description"*). The judge is told to enforce them
**only when the current turn's conditions hold**. Otherwise, the
preference is not active and the reply is allowed to discuss it
abstractly.

### 5.3. Fail-safe

LLM judge error → approve.

---

## 6. How the guards compose

In a single turn, the order is:

1. **Stall / ReAct** runs *before* the model reply is admitted.
2. **Ralph Loop** runs *at* the moment the sub-agent says "I'm done".
3. **Side-Effect Guard / TES** runs *between* each batch of tool calls.
4. **Turn Integrity Guard** runs *after* finalization.
5. **Coherence Guard** runs *after* the integrity check.

A turn can bounce between 1, 2, and 3 multiple times. Once the agent
finalizes, 4 and 5 fire exactly once.

When a guard rejects, the rejection **does not erase the agent's work**.
The work is preserved in `messages`, `events`, and the worklog. The agent
just gets a re-prompt that demands a correction or continuation. This
keeps the audit trail complete and lets the user see the rejected text in
`SessionForensics` for debugging.

---

## 7. EVIDENCE-FIRST RULE (system-prompt-level, semantic)

**Source:** commit `dbb756c`. Lives in the orchestrator system prompt in
[`src/core/runtime/modelAdapter.ts`](../src/core/runtime/modelAdapter.ts)
under `## Visual & Media Processing Protocol` (non-sub-agent branch).

This is not a post-hoc guard. It is a behavioral rule the assistant must
follow *before* responding.

### 7.1. What it enforces

When the user asks to **enumerate, list, count, read, show, or inventory**
the current state of a dynamic system resource — skills, sessions, files,
directories, channel configs, processes, tool lists, model profiles, logs,
database state — the assistant must:

1. Execute the appropriate tool first (`ListSkills`, `Read`, `Glob`,
   `list_files`, `list_sessions`, etc. depending on what was asked).
2. Answer with the result the tool returned.
3. **Never** answer from memory and bolt on a disclaimer
   (*"tomátelo con pinzas"*, *"no verifiqué"*, *"ojo con eso"*,
   *"si querés el 100% decime y lo corro"*).

The rule explicitly lists which resources it covers:

> *skills, dynamic skills, sessions, files, directories, channel configs,
> processes, tool lists, model profiles, logs, database state, and any
> other resource that has a tool to query it.*

### 7.2. Memory is for context, not for live state

Memory (Palace facts, BOOT wings, prior turn context) is still the right
place for *preferences, history, conversation continuity, and reasoning*.
It is the wrong place for the *live state* of any system resource that has
a tool to query it.

### 7.3. Backstop: the `enumerate_dynamic_state` Ralph rule

The Ralph Loop can fire a corrective message if the rule is violated. The
rule is registered in
[`src/core/tools/registry.ts`](../src/core/tools/registry.ts) under
`indexRalphRulesInPalace`. **It is registered with an empty
`requiredTools` array** because the rule covers many resources, each
mapping to a different tool — a hardcoded list would either be too narrow
(causing false positives on legitimate `Read`/`Glob` calls) or too broad
(never firing). The orchestrator's `checkDynamicRalphRules` skips rules
with empty `requiredTools`, so the EVIDENCE-FIRST system-prompt rule is
the actual enforcement layer; the Ralph rule entry is kept for visibility
and future re-tuning.

### 7.4. Level 0 supremacy still applies

If the user explicitly says *"no listes, decime de memoria"* or
*"sin verificar"*, that override beats EVIDENCE-FIRST. The rule is a
default behavior, not an absolute hard constraint.

---

## 8. Auditing guard behavior

Every guard rejection is a one-line worklog entry with a stable prefix.
To audit a session:

```bash
sqlite3 ~/.monolito/memory/memory.sqlite \
  "SELECT summary, at FROM worklog
   WHERE session_id = ? AND summary LIKE '%GUARD%' OR summary LIKE '%BROKEN_PROMISE%'
   ORDER BY at ASC"
```

Or use the in-app `SessionForensics` tool, which is the supported
interface and returns the same data with surrounding context.

If you see the same guard rejecting on the same turn more than 3 times
in a row, the agent is probably stuck in a contradiction with the user
profile or the dynamic rules. Read the latest Palace memories and the
active `RalphRule` rows; something is asserting an impossible prerequisite.

---

## 9. Destructive Action Guard (pre-execution, per-channel)

Replaces the old `resolveWorkspacePath` interactive permission system.
Instead of gating filesystem reads/writes by path (which caused friction and was bypassed by tools like `Bash`), the runtime now:
- Allows **free reads** from any path (no prompt)
- Allows **writes/edits** within workspace + `MONOLITO_ROOT` (no prompt)
- Detects **destructive or irreversible actions** (such as dangerous `Bash` commands matching `rm`, `kill`, `shutdown`, etc.)
- Adapts the confirmation prompt to the **active session channel**:
  - **CLI session**: Shows a yellow `DESTRUCTIVE ACTION DETECTED` prompt in the TUI, allowing the user to select `[A]llow once`, `[S]ave always`, or `[D]eny`.
  - **Telegram channel**: Sends an inline keyboard with `✅ Allow` / `❌ Deny` buttons.
  - **Headless workers / Sub-agents**: Automatically denies the action immediately to avoid hanging.
  - **Timeouts**: Auto-denies after 30s for interactive channels if the user does not respond.

