# Monolito V2 — Agent Instructions

This document provides technical guidance, architecture rules, and operational procedures for AI agents working on the Monolito V2 codebase.

## Architecture

Monolito is a local AI orchestration runtime with SQLite-backed persistence. It runs a single main session per turn; user-facing sub-agent delegation is **not** a feature (the orchestrator was removed in migration `20260611_drop_worker_tables.sql`). Internal maintenance work (memory consolidation, skill curation) runs as silent in-process turns, not as workers.

### Core Layers
- **daemon** (`src/apps/daemon.ts`): Owns the runtime server, session management, and channel integration. Receives requests via Unix socket IPC.
- **runtime** (`src/core/runtime/runtime.ts`): The orchestration engine. Manages active sessions, turn execution, tool dispatch, and silent background maintenance.
- **top-level Ralph gate** (`src/core/runtime/topLevelRalphGate.ts`): Stop-hook analog for the main session — re-feeds the model if `active_tasks` wing has unfinished TodoWrite items.
- **model adapter** (`src/core/runtime/modelAdapterLite.ts`): Builds prompts with prompt caching, handles provider recovery (429 backoff, 401/403 reauth, 503/529 retry, context overflow).
- **tool registry** (`src/core/tools/registry.ts`): Tool definitions with permission tiers and execution harnesses.
- **session store** (`src/core/session/store.ts`): SQLite persistence (messages, worklog, events, BOOT wings, Memory Palace, graph).

## Memory System (3 layers)

1. **`BOOT_*` wings**: Deterministic bootstrap state (identity, user profile, workspace rules, long-term memory).
   - **Single-User Architecture**: Boot wings are seeded exclusively under the `default` profile scope. Other profiles transparently inherit these wings via global fallback, preventing redundant, duplicate rows in SQLite.
   - **Standard Boot Wings**: The allowed boot wings are `BOOT_AGENTS`, `BOOT_SOUL`, `BOOT_TOOLS`, `BOOT_IDENTITY`, `BOOT_USER`, `BOOT_BOOTSTRAP`, and `BOOT_MEMORY`. Creating or writing to custom wings (like `BOOT_PERSONALITY`) is strictly blocked at the tool registry layer.

### Automatic Memory Consolidation & Skill Synthesis
- **MemoryAgent**: A minimalist, 100% silent agent triggered automatically during the heartbeat check when the user is inactive to synthesize and organize semantic facts.
  - **Workflow**: Reads recent conversation history, reasons step-by-step about what is important (identity, user profile, general or thematic facts, commitments, projects), and uses the `BootWrite` and `WorkspaceMemoryFiling` tools to store facts in the Memory Palace (`BOOT_WINGS`, `palace_nodes`, `memory_drawers`).
  - **Silent Operation**: Runs without adding messages to the thread or sending notifications to Telegram/terminal. Logs are recorded only as a note in the session worklog (`MemoryAgent executed silently: CONSOLIDATION_OK`).
- **SkillsAgent**: An automatic, background automation and skill lifecycle agent triggered immediately after `MemoryAgent` during the heartbeat check when the user is inactive.
  - **Workflow**: 
    1. Reads existing dynamic skills using `ListSkills` to analyze the active library.
    2. Reads recent tool usage, terminal outputs, and Bash command logs to identify repetitive tasks, obsolete patterns, or paradigm shifts.
    3. Automates repetitive sequences by generating robust, parameterized Bash scripts via `CreateSkill`.
    4. Merges redundant or overlapping skills under a broad "umbrella" skill (using `CreateSkill` and `DeleteSkill`).
    5. Updates outdated skills to match new project paradigms (e.g. `npm` to `pnpm`).
    6. Prunes obsolete or broken skills using `DeleteSkill`.
  - **Scope Boundary**: SkillsAgent must only synthesize procedural skills (SOPs consisting of executable system tools/actions). It is strictly forbidden from creating skills for cognitive directives, behavioral warnings, rules of engagement, or user preferences, which are the exclusive domain of MemoryAgent and must be filed in the Memory Palace.
  - **Silent Operation**: Fully silent, recording its outcomes only to the session worklog (`SkillsAgent executed silently: SKILLS_OK`).

### Cognitive Task Persistence & Top-Level Ralph Loop
- **Cognitive Task Tracking**: The main session uses the SQLite Memory Palace (`palace_nodes` table, `active_tasks` wing) instead of files (like `tasks.json`) to register, track, and update its intermediate objectives. This maintains cross-turn cognitive state, visible and manageable via `TodoWrite`, `TodoList`, and `TodoUpdate` tools.
- **Top-level Ralph Loop**: The runtime refuses to deliver the assistant reply if there are:
  1. Unfinished or pending tasks (`pending` or `in_progress`) in the `active_tasks` wing.
  2. Last executed terminal command (`Bash` tool run) returning a non-zero exit code.
- **Self-Correction loops**: If any of these checks fail, the main session is automatically locked inside a correction loop with structured feedback (`buildRalphLoopUnfinishedTasksPrompt`) until it resolves the open items or returns `TASK_FAILED:<reason>`. After `TOP_LEVEL_RALPH_MAX_ATTEMPTS = 20` attempts, the loop delivers a honest `TASK_FAILED` message to the user instead of silently dropping the empty assistant reply.

## Full Tool Access Model

Monolito V2 implements a full tool access model. Instead of dynamically pre-filtering and limiting tool availability at the start of each turn using semantic search (RAG), the runtime exposes the complete catalog of active system tools to the LLM on every call.

### Core Mechanics
1. **Full Tool Exposure**: The agent has immediate and direct access to all system tools (such as `Bash`, `system_status`, `tool_manage_config`, `TelegramSend`, etc.) at all times, preventing tool-blindness and eliminating intermediate workaround scripts.
2. **Static Scope Filtering**: Tools are still filtered statically based on security context (e.g. hiding service-management tools or daemon controls from specific channel environments like Telegram).
3. **Dynamic Tool Indexing**: System tool definitions and active dynamic skills are still synchronized and indexed semantically at daemon startup in the Memory Palace (`CONF_TOOLS` memory wing). This supports meta-queries and interactive CLI tools.

## Runtime vs Local (Operational)

- **Production Monolito runs on VPS** (SSH alias: `vps`), not from this local checkout.
- Before diagnosing runtime behavior, slash commands, or Telegram issues: verify whether the user means the VPS instance.
- Use the VPS only for diagnostics (logs, config, process state).
- **Do not edit VPS files**, patch code, or apply hotfixes there.
- **Workflow**: Code corrections in local checkout → validate → commit → user deploys via `/update` on the VPS.

## VPS Diagnostics & Session Auditing

When troubleshooting or verifying agent behavior on the VPS (SSH alias: `vps`), follow these commands to audit the runtime state:

### 1. View & Filter Daemon Logs
- Tail live logs: `ssh vps "tail -f ~/.monolito-v2/logs/monolitod.log"`
- Search for specific tool calls (e.g. `WebSearch`): `ssh vps "grep -i 'WebSearch' ~/.monolito-v2/logs/monolitod.log"`

### 2. Inspect SQLite Database
Since the VPS might not have `sqlite3` installed globally, query the database using inline Node.js scripts executed inside the remote project directory:
- **Retrieve active session & recent messages**:
  ```bash
  ssh vps "cd ~/Monolito-V2 && node -e \"
  const db = new (require('better-sqlite3'))('/home/ubuntu/.monolito-v2/memory/memory.sqlite');
  const session = db.prepare('SELECT id, title FROM sessions ORDER BY updated_at DESC LIMIT 1').get();
  console.log('Session:', session);
  if (session) {
    const messages = db.prepare('SELECT role, text FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 5').all(session.id);
    messages.reverse().forEach(m => console.log('[\x1b[32m' + m.role + '\x1b[0m]: ' + m.text));
  }
  \""
  ```
- **Inspect `websearch_history` cache** for the active session:
  ```bash
  ssh vps "cd ~/Monolito-V2 && node -e \"
  const db = new (require('better-sqlite3'))('/home/ubuntu/.monolito-v2/memory/memory.sqlite');
  const session = db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1').get();
  if (session) {
    const nodes = db.prepare('SELECT node_key, content FROM palace_nodes WHERE room = ? AND wing = ?').all(session.id, 'websearch_history');
    nodes.forEach(n => console.log('Source Key:', n.node_key, '\nContent Length:', n.content.length));
  }
  \""
  ```

### 3. Send Headless Test Prompts
To test exact prompt reasoning, tool execution, and source-caching on the VPS without opening the TUI client:
```bash
ssh vps "cd ~/Monolito-V2 && node --experimental-strip-types bin/monolito.js ask 'tu prompt de prueba'"
```

## Development Workflow

### Build & Check
```bash
npm run build   # tsc --noEmit (typecheck only)
npm run check   # cli --help (validates the app boots)
npm run daemon  # start daemon directly
npm run cli     # start CLI (spawns daemon if not running)
npm run db:migrate
```

### Execution Model
- TypeScript runs directly via `node --experimental-strip-types`. No compilation step.

### Multi-Agent
- The user-facing sub-agent delegation feature was **removed** in migration `20260611_drop_worker_tables.sql`. There are no `AgentSpawn` / `delegate_background_task` / `AgentSendMessage` / `AgentStop` tools. The orchestrator class and `worker_jobs` / `background_tasks` / `background_task_groups` tables no longer exist.
- For background maintenance, see [`docs/background-agents.md`](./docs/background-agents.md) — MemoryAgent and SkillsAgent run as silent in-process turns, not as workers.

### IPC & Events
- **IPC**: Daemon ↔ CLI communicate over Unix socket (`/tmp/monolitod-v2-*.sock`).
- **Events**: `message.received`, `turn.completed` are the canonical runtime events. The legacy `worker:completed` event was removed with the orchestrator.

### Adult Mode
- Adult mode (`/adult`) is session-scoped. The active session's adult flag is read by tools that need it.
- **Dynamic SafeSearch adjustment:** Core search tools (like `ImageSearch`) check the session's adult mode status and automatically disable search filters (e.g. sending `safesearch=0` to SearXNG) when adult mode is active, while defaulting to safe/moderate filtering (`safesearch=1`) otherwise.

## EVIDENCE-FIRST Rule (Dynamic System State)

When the user asks to enumerate, list, count, read, show, or inventory the
current state of a dynamic system resource (skills, sessions, files,
channels, processes, tools, configs, profiles, models, logs, database
state, etc.):

1. Execute the appropriate tool first.
2. Answer with the result the tool returned.
3. **Do not** answer from memory and bolt on a disclaimer
   (*"tomátelo con pinzas"*, *"no verifiqué"*, *"si querés el 100%
   decime y lo corro"*).

This rule is enforced by the system prompt in
`src/core/runtime/modelAdapter.ts` under `## Visual & Media Processing
Protocol` (the main-session branch). A backstop `enumerate_dynamic_state`
Ralph rule is registered with an empty `requiredTools` array as
documentation; the system-prompt rule is the actual enforcement layer.
Full architecture and rationale:
[`docs/guards.md`](./docs/guards.md#7-evidence-first-rule-system-prompt-level-semantic).

The rule is overrideable by Level 0 user intent: an explicit *"no
verifiques"*, *"sin chequear"*, *"decime de memoria"* wins.

## Key Paths & Files

- **Local runtime state**: `~/.monolito/`
- **Local memory DB**: `~/.monolito/memory/memory.sqlite`
- **Local daemon log**: `~/.monolito/logs/monolitod.log`
- **On VPS**: legacy production runtime lives under `~/.monolito-v2/`; do not edit VPS files directly.
- **Local PC Workspace**: `/home/cristian/.claude/workspace/proyectos/Monolito V2`
- **Local PC Production/Service App**: `/home/cristian/.monolito/app`

## Code Guidelines

- **Bug Fixes**: Do not hardcode specific user phrasings. Solve with general rules, state modeling, or runtime structure.
- **Prompt-Based Solutions**: Prompt engineering or prompt modifications must be treated as a last resort, to be used only when code-based, structural, state-based, or algorithmic solutions are completely unviable.
- **Strict Limitation on Modifications**: You are strictly FORBIDDEN from modifying, creating, or deleting source code files, test scripts, or configuration files in the local workspace or the VPS checkout unless the user has explicitly and directly requested you to do so in the chat.
- **No Hallucinate Configuration**: Agents/workers MUST NOT hallucinate or textually claim they have modified, saved, or loaded system configurations (such as active channels, Telegram tokens, or search credentials) without having first invoked the corresponding configuration management tools (`tool_manage_config` or matching registry endpoints).
- **Configuration Management (`tool_manage_config`)**: Agents MUST use `tool_manage_config` for reading/writing configuration wings (`CONF_MODELS`, `CONF_SYSTEM`, `CONF_CHANNELS`, `CONF_WEBSEARCH`, `CONF_MCP`, `CONF_POLICY`, `CONF_HEARTBEAT`). It supports:
  - `action: "read"`: Read entire configuration block of a wing.
  - `action: "write"`: Replace entire configuration block of a wing.
  - `action: "get"`: Read a specific path using dot-notation (e.g., `telegram.enabled`).
  - `action: "set"`: Update a specific path using dot-notation (e.g., `telegram.enabled`).
  - `action: "activate_model"`: Atomically switch the active model profile using its ID and reload model settings.
- **Documentation**: Agents MUST update relevant documentation (README, `docs/`, `AGENTS.md`) immediately after making changes to the code to ensure it always reflects the current architecture and implementation.
- **After Changes**: Run `npm run build` to typecheck before committing.
- **Commit**: The agent MUST perform the git commit of the changes once all checks pass. Use concise messages and group logical changes.

## Grok OAuth Integration (`xai-oauth`)

Monolito V2 supports dynamic browser-based OAuth authentication for personal X Premium+ (SuperGrok) accounts.
- **CLI Command**: `monolito auth xai-oauth` spins up a secure temporary HTTP loopback listener at `127.0.0.1:56121/callback`, opens the system browser, captures the code, and exchanges it for tokens. On success, it automatically registers and activates a new `"xai-oauth"` model profile.
- **Token Cache**: Persisted locally at `~/.monolito/grok_oauth.json` containing access, id, and refresh tokens.
- **Auto-Refresh Lifecycle**: Resolved dynamically at runtime inside the main API execution loops by `resolveGrokAccessToken()` in `src/core/runtime/providers/grokAuth.ts`. It transparently checks validity and refreshes using the OIDC token endpoint before making calls.
- **Prompt Caching**: Enabled automatically for both `"xai"` and `"xai-oauth"` providers by injecting the `x-grok-conv-id` header matching the current active `sessionId`.

## Context Engine & Memory Budget Management

Monolito V2 uses a advanced 3-layer Context Engine to prevent "amnesia" and ensure robust, high-fidelity context preservation during long sessions, replacing the legacy destructive `compactSession` method.

### 1. Capa 1: Guardias Preventivos (Preventive)
- **Head+Tail Truncation**: Done automatically in `src/core/context/toolResultGuard.ts` on tool outputs. If a tool result exceeds the dynamic character budget, it truncates the middle but keeps the header (start of stdout) and tail (errors, stack traces, exit codes).
- **Dynamic Budgets**: Individual tool outputs are capped at a maximum of 30% of the active model's context window (e.g., ~38K tokens/150K chars for Claude).
- **Disk Offloading**: Massive tool outputs are written completely to a temporary file in `scratchpad/`, leaving a Head+Tail preview in-context with instructions to read the full file if necessary.

### 2. Capa 2: Compactación Inteligente (Compaction)
- **Protected Zones**: The system prompt, the first user prompt and first assistant reply (Head Zone) are fully protected. The last 3 complete user-assistant-tools turns (Tail Zone) are also preserved untouched.
- **Tier 1 (In-Memory Snip)**: Snippets old `"tool"` messages in the active turn list to `[tool output compacted]` placeholders when total tokens exceed 80% of the budget.
- **Tier 2 (LLM Summary)**: Proactively calls a background LLM task to summarize the intermediate non-protected messages in the database and replaces them in-place with a high-fidelity summary instead of physical deletions.

### 3. Capa 3: Recuperación (Recovery & Fail-safe)
- **Recovery Cascade**: If a hard `ContextOverflowError` is returned by the provider, the agent loop executes DB Tier 2 compaction and in-memory Tier 1 compaction, reloads the session state, and merges the current turn's active tool results to retry without repeating prior tool executions.
- **Anti-Thrash & Snapshots**: If compaction occurs more than 3 times in a single turn without resolving the error, the engine aborts the turn and writes a complete JSON trajectory dump of all messages to `snapshots/` under the Monolito root for debugging.

## Vision Engine & Multi-tier Image Processing

Monolito V2 implements a dual-tier visual processing pipeline to handle visual verification and analysis efficiently:

### 1. Cloud Model Vision (`VisionAnalyze`)
- **Primary Execution**: When the model needs to analyze or verify an image (e.g. for Telegram delivery verification), it prioritizes `VisionAnalyze`.
- **Mechanism**: Invokes the cloud model's native multimodal capabilities (Anthropic or OpenAI-compatible) via API. This is extremely fast (takes ~2 seconds) and does not consume server resource overhead.
- **Local Cache**: If the image was requested from a URL, `VisionAnalyze` automatically downloads and buffers the file, writes it to `scratchpad/`, and returns its absolute `local_path` so it is ready for Telegram delivery.

### 2. Local Fallback Vision (`AnalyzeImage`)
- **Fallback Execution**: If `VisionAnalyze` is not supported by the active cloud provider, fails (timeouts, credentials, rate limits), or if offline mode is enforced, the runtime falls back automatically to `AnalyzeImage`.
- **Mechanism**: Deploys a local docker container running Ollama with the `moondream` model (`monolito-vision-moondream`).
- **Performance Notice**: Since VPS nodes are usually CPU-only (lacking hardware acceleration), local vision inference can be highly intensive and take up to several minutes per image. Thus, cloud-based `VisionAnalyze` must always be prioritized.

## Transactional Execution Stack (TES) & Side-Effect Guard

Monolito V2 implements a transaction-like execution mechanism for tools with irreversible external side-effects (e.g., sending messages or media to Telegram: `TelegramSend`, `TelegramSendPhoto`, etc.).

### 1. Concepto y Funcionamiento
- **Detección de Side-Effects**: Las herramientas que producen cambios irreversibles en el mundo exterior tienen el flag `sideEffect: true` en su definición en [registry.ts](file:///home/cristian/.claude/workspace/proyectos/Monolito%20V2/src/core/tools/registry.ts).
- **Turn Execution Stack (TES)**: Durante la ejecución del turno en `runAgentLoop`, si el modelo genera llamadas a herramientas con side-effects, el runtime las intercepta y las encola en un buffer (`TurnExecutionStack`). En su lugar, devuelve de inmediato un resultado ficticio marcando la herramienta como `"buffered"`.
- **Evaluación del LLM**: Antes de guardar los resultados y continuar el bucle, si hay herramientas buffered pendientes, se invoca síncronamente al **Side-Effect Guard** (`checkSideEffects`).
- **Resolución**:
  - **Aprobado**: Se ejecutan las herramientas encoladas en orden y se reemplazan sus placeholders con los resultados reales de ejecución.
  - **Rechazado**: Se bloquea la ejecución del buffer, y se reemplaza el placeholder con un error descriptivo (`[Side-Effect Guard] Ejecución bloqueada: <reason>`), registrando el evento en el log de trabajo (`SIDE_EFFECT_GUARD_BLOCKED`).

### 2. Guardián Basado en Memoria (Cero Políticas Hardcodeadas)
- El guardián no usa expresiones regulares ni políticas pre-definidas.
- **Fuentes de Verdad**: Consulta de forma dinámica el perfil del usuario (`BOOT_USER`) y recuerda memorias semánticas afines al contexto (`palace_nodes` de RAG).
- **Ejemplo Práctico**: Si el usuario ha instruido al agente mediante lenguaje natural *"siempre verifica las fotos con VisionAnalyze antes de mandarlas por Telegram"*, esa regla se almacena en memoria. El Side-Effect Guard detecta que se intenta ejecutar `TelegramSendPhoto` sin haber llamado previamente a `VisionAnalyze` en el turno y bloquea preventivamente la acción.
- **Fail-Safe**: Si la validación del LLM falla por timeout o error técnico, el guardián actúa en modo permisivo y **aprueba** por defecto para asegurar la continuidad operativa de la sesión.
- **Diagnóstico de bloqueos**: cada rechazo del guard emite un `logger.warn` estructurado a `~/.monolito/logs/monolitod.log` con el prefijo `[SideEffectGuard] BLOCKED`. Para investigar un bloqueo desde la tool loop, llamá a `QueryGuardStatus` (tool read-only en `admin.ts`) — devuelve los últimos N eventos del worklog con `at`, `reason` y `level0Override`. La tool se complementa con `grep "[SideEffectGuard]" ~/.monolito/logs/monolitod.log` para el audit trail completo (incluye el pending tool list).

## Destructive Action Guard

Monolito V2 implements a per-channel Destructive Action Guard to replace the legacy path-permission prompts:
- **Free Reads**: Filesystem reads/access are unrestricted and never prompt the user.
- **Unprompted Edits/Writes**: Writes inside the workspace + `MONOLITO_ROOT` do not require interactive confirmation.
- **Destructive Action Interception**: Actions flagged as destructive (e.g. dangerous `Bash` commands matching `rm`, `kill`, `shutdown`, etc.) are intercepted.
- **Adaptive Channel Prompts**:
  - **CLI TUI**: Surfaces a `⚠️ DESTRUCTIVE ACTION DETECTED` prompt asking the user to confirm via `[A]llow once`, `[S]ave always`, or `[D]eny`.
  - **Telegram**: Sends an inline keyboard with `✅ Allow` / `❌ Deny` buttons.
  - **Headless workers / Sub-agents**: Automatically denied immediately.
  - **Timeout**: Requests auto-deny after 30 seconds if unanswered.

## TTS Architecture (hosted only)

TTS in Monolito V2 is **hosted-only**: no managed local Docker container. `GenerateSpeech` supports two providers, controlled by `tts_provider`:

- **MiniMax** (`/v1/t2a_v2`): the active MiniMax model profile is used as credential fallback when `tts.apiKey` is unset. Voice aliases in `tts.clonedVoices` are resolved automatically.
- **OpenAI-compatible** (`/v1/audio/speech`): `tts.baseUrl` must point to a hosted OpenAI-compatible API (e.g. `https://api.openai.com/v1`).

`VoiceClone` is MiniMax-only and persists the cloned voice as an alias in `tts.clonedVoices`.

The legacy `TtsService*` tools (`TtsServiceStatus` / `Deploy` / `Stop` / `Remove` / `List`) and the `tts_managed` / `tts_auto_deploy` / `tts_port` config fields were removed. `/config set tts_managed` and friends now return an error pointing the user to the hosted providers. Old deployments that still have these fields in `CONF_CHANNELS` continue to work — the normalizer ignores the unknown fields.

