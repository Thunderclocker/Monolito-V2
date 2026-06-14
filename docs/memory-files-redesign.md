# Memoria basada en archivos (Markdown)

Monolito V2 almacena la memoria del agente en archivos legibles bajo `$MONOLITO_ROOT/memory/`.

## Layout

```
memory/
  boot/
    user.md       ← BOOT_USER
    soul.md       ← BOOT_SOUL
    identity.md   ← BOOT_IDENTITY
    agents.md     ← BOOT_AGENTS
    tools.md      ← BOOT_TOOLS
    bootstrap.md  ← BOOT_BOOTSTRAP
  memory.md       ← BOOT_MEMORY + hechos curados (digest)
  archive/        ← (opcional) memoria vieja, solo búsqueda
  config/
    CONF_MODELS.json
    CONF_SYSTEM.json
    CONF_CHANNELS.json
    ...
  profiles.json
  sessions/
    <sessionId>/
      meta.json
      messages.jsonl
      worklog.jsonl
      events.jsonl
      tasks.json
      sources.json
  state/
    knowledge_graph.jsonl
    ralph_rules.json
    semantic_tools.json
    processing_cursors.json
    telegram/
      raw_updates.jsonl
      sent_photos.jsonl
```

Almacenamiento **solo en archivos** bajo `memory/` (sin SQLite).

## Carga en cada turno

- `boot/*.md` + `memory.md` se cargan **completos** en el bloque `memoryBlock` del system prompt.
- Ese bloque va con **prompt caching** (`cache_control: ephemeral`) — costo bajo en turnos consecutivos.
- **No hay recall de “3 resultados”** para memoria: el modelo lee el digest entero.

## MemoryAgent

Mantiene `memory.md` como **digest curado** (~12 KB máx.). Debe consolidar, deduplicar y podar — no solo appendear.

## Herramientas

| Tool | Acción |
|------|--------|
| `BootRead` / `BootWrite` | Editar `boot/*.md` o `memory.md` |
| `WorkspaceMemoryFiling` | Nueva/actualizada sección `##` en `memory.md` |
| `WorkspaceMemoryRecall` | Buscar secciones en `memory.md` |
| `SearchHistory` | Buscar en historial de chat (keyword scan sobre JSONL) |

## Config hot-reload (Jun 2026)

- `tool_manage_config` writes to `memory/config/CONF_*.json`.
- `CONF_WEBSEARCH` changes apply immediately (`effect: config_stored`) — tools read config on each call.
- `CONF_CHANNELS` changes trigger in-process `reloadChannels()` (`effect: channels_reload_required`) — Telegram poller restarts without full daemon exit.
- `get` / unchanged `set` returns `effect: none` — safe to verify `telegram.enabled` without reconfiguring.

## Git

Con `MONOLITO_MEMORY_GIT` distinto de `0` (default), cada escritura intenta `git commit` en `memory/`.

## Proactividad

Preguntas de seguridad de PC (`¿qué tan segura es mi pc?`) activan el **Ralph gate**: obliga `Bash` / `system_status` antes de responder.
