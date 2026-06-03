# Monolito V2 — Agent Instructions

This document provides technical guidance, architecture rules, and operational procedures for AI agents working on the Monolito V2 codebase.

## Architecture

Monolito is a local AI orchestration runtime with SQLite-backed persistence and multi-agent delegation.

### Core Layers
- **daemon** (`src/apps/daemon.ts`): Owns the runtime server, session management, and channel integration. Receives requests via Unix socket IPC.
- **runtime** (`src/core/runtime/runtime.ts`): The orchestration engine. Manages active sessions, turn execution, tool dispatch, and background delegation.
- **orchestrator** (`src/core/runtime/orchestrator.ts`): Spawns/stops worker sub-agents, tracks tasks, and enforces token budgets.
- **model adapter** (`src/core/runtime/modelAdapterLite.ts`): Builds prompts with prompt caching, handles provider recovery (429 backoff, 401/403 reauth, 503/529 retry, context overflow).
- **tool registry** (`src/core/tools/registry.ts`): Tool definitions with permission tiers and execution harnesses.
- **session store** (`src/core/session/store.ts`): SQLite persistence (messages, worklog, events, tasks, BOOT wings, Memory Palace, graph).

## Memory System (3 layers)

1. **`BOOT_*` wings**: Deterministic bootstrap state (identity, user profile, workspace rules, long-term memory).
   - **Single-User Architecture**: Boot wings are seeded exclusively under the `default` profile scope. Other profiles (Amanda, coder, coordinator) transparently inherit these wings via global fallback, preventing redundant, duplicate rows in SQLite.
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
  - **Silent Operation**: Fully silent, recording its outcomes only to the session worklog (`SkillsAgent executed silently: SKILLS_OK`).

### Cognitive Task Persistence & Relentless Execution (Ralph Loop)
- **Cognitive Task Tracking**: Sub-agents use the SQLite Memory Palace (`palace_nodes` table, `active_tasks` wing) instead of files (like `tasks.json`) to register, track, and update their intermediate objectives. This maintains cross-turn cognitive state, visible and manageable via `TodoWrite`, `TodoList`, and `TodoUpdate` tools.
- **Relentless Loop Checks**: The orchestrator prevents sub-agents from completing a turn if there are:
  1. Missing verification tags (`<verified>SUCCESS</verified>`).
  2. Unfinished or pending tasks in their database room.
  3. Last executed terminal command (`Bash` tool run) returning a non-zero exit code.
- **Self-Correction loops**: If any of these checks fail, the sub-agent is automatically locked inside a correction loop with systemic feedback until it resolves all errors and marks its tasks as completed.

## Semantic Tool Routing & Discoverability

Monolito V2 uses vector similarity search via `sqlite-vec` in the Memory Palace (`CONF_TOOLS` memory wing) to dynamically pre-filter and route tools based on user intent semantic matching, reducing system prompt token overhead and improving tool-selection accuracy.

### Core Mechanics
1. **Dynamic Tool Indexing**: At daemon startup, all system tool definitions (name, description, input schema) are synchronized and embedded into the Memory Palace using the local `nomic-embed-text` engine.
2. **Turn pre-filtering**: At the beginning of each turn execution in `runAssistantTurn`, a cosine similarity vector query searches for the top 5 most relevant tools for the user request.
3. **Resilience & Timeout Fallback**: The query runs in a parallel `Promise.race` with a **strict 200ms timeout**. If embeddings generation or the database query takes longer or fails, the orchestrator automatically falls back to full tool availability.
4. **Core-Tool Pinning**: Essential core tools (e.g. `Bash`, `Write`, `Edit`, `TodoWrite`, `TodoList`, `TodoUpdate`, `delegate_background_task`, `search_tools`) are *always* preserved in the tool list regardless of vector search results, ensuring the agent is never isolated from coordination or editing abilities.
5. **Meta-Tool Discovery (`search_tools`)**: If a specific tool is omitted from the pre-filtered context, the agent can dynamically call `search_tools` with a natural language search query to query the complete database registry and discover other tools on-the-fly.

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
- Sub-agents run in isolated Git Worktrees with temporary branches.
- Parent session controls lifecycle (spawn, stop, continue).
- Workers report via task notifications. Completion is signaled via `<task-notification>` in the message stream.

### IPC & Events
- **IPC**: Daemon ↔ CLI communicate over Unix socket (`/tmp/monolitod-v2-*.sock`).
- **Events**: `src/core/events/bus.ts` — internal pub/sub. Key events: `worker:completed` (fires Telegram push), `message.received`, `turn.completed`.

### Adult Mode
- Adult mode (`/adult`) is session-scoped. Workers inherit this flag in their context extras.
- **Dynamic SafeSearch adjustment:** Core search tools (like `ImageSearch`) check the session's adult mode status and automatically disable search filters (e.g. sending `safesearch=0` to SearXNG) when adult mode is active, while defaulting to safe/moderate filtering (`safesearch=1`) otherwise.

## Key Paths & Files

- **Local runtime state**: `~/.monolito/`
- **Local memory DB**: `~/.monolito/memory/memory.sqlite`
- **Local daemon log**: `~/.monolito/logs/monolitod.log`
- **Local worker logs**: `~/.monolito/logs/instances/worker-*.log`
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
- **Primary Execution**: When a sub-agent needs to analyze or verify an image (e.g. for Telegram delivery verification), it prioritizes `VisionAnalyze`.
- **Mechanism**: Invokes the cloud model's native multimodal capabilities (Anthropic or OpenAI-compatible) via API. This is extremely fast (takes ~2 seconds) and does not consume server resource overhead.
- **Local Cache**: If the image was requested from a URL, `VisionAnalyze` automatically downloads and buffers the file, writes it to `scratchpad/`, and returns its absolute `local_path` so it is ready for Telegram delivery.

### 2. Local Fallback Vision (`AnalyzeImage`)
- **Fallback Execution**: If `VisionAnalyze` is not supported by the active cloud provider, fails (timeouts, credentials, rate limits), or if offline mode is enforced, the sub-agent falls back automatically to `AnalyzeImage`.
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
