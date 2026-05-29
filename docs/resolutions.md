# Resolutions Log

Registro de diagnósticos y fixes aplicados por el ciclo de monitoreo automatizado.

---

## 2026-04-28 — Worker hallucina `client.beta.vision.analyze()` via Bash

**Commit:** `da28429`

### Falla Observable
El worker de imagen ejecutó un script Python via Bash usando `client.beta.vision.analyze()`,
una API que no existe en OpenAI. El script descargó las imágenes correctamente pero falló
al intentar analizarlas, resultando en un traceback `AttributeError: 'Beta' object has no
attribute 'vision'`. La tarea de imágenes quedó sin completar.

### Causa Raíz
El system prompt del worker (`modelAdapter.ts`) solo decía: "You are a worker. Complete
the task directly with the tools available to you." No había ninguna restricción explícita
contra usar Bash para invocar APIs externas de visión. El LLM eligió generar un script
Python inventado en lugar de usar la herramienta `AnalyzeImage` del arnés.

El worker tenía acceso a `Bash` y `AnalyzeImage`, pero sin una regla semántica que
discriminara su uso, eligió el camino hallucinated.

### Fix Aplicado
1. **`src/core/runtime/modelAdapter.ts`**: Agregado bloque `REGLAS CRÍTICAS PARA WORKERS`
   en el system prompt del sub-agente que prohíbe explícitamente usar Bash para invocar APIs
   de LLM/visión y obliga a usar `AnalyzeImage`. También exige reporte de error explícito
   si `AnalyzeImage` falla, sin fallback vía Bash.

2. **`src/core/tools/registry.ts`**: Agregada restricción `PROHIBIDO` en la `description` del
   tool `Bash` para bloquear el patrón a nivel de selección de herramienta (doble barrera).

### Verificación Estática
- `npm run build` → 0 errores TypeScript.

### Despliegue Autónomo (2026-04-28T01:18Z)
- `git pull` en VPS: 3 archivos actualizados (`17cd7e9..4a54b83`).
- Daemon tenía proceso huérfano (pid 3105212, self-restart de sesión anterior) bloqueando el arranque.
  Se limpió el socket `/tmp/monolitod-v2-ec87887abb3d.sock` y se reinició vía `systemctl --user start monolito.service`.
- Daemon levantó correctamente con PID 3114307, Telegram activo.

### Test E2E: VERDE ✅
- Estímulo inyectado vía Telegram API: `"mandame 2 fotos de tanques de guerra rosas"` (msg_id 3290).
- Worker `agent-default-33d13481` spawneado a las 01:20:52, completado en ~4 min.
- Resultado: ambas imágenes descargadas, analizadas con `AnalyzeImage` (Moondream local), enviadas vía `TelegramSendPhoto` (msg_ids 3293 y 3294).
- **Sin `client.beta.vision.analyze()`. Sin `AttributeError`. Sin script Python hallucinated.**
- El patrón de falla fue eliminado. El worker usó el arnés correctamente.
