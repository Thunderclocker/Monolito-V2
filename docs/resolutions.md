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
El system prompt del worker (`modelAdapterLite.ts`) solo decía: "You are a worker. Complete
the task directly with the tools available to you." No había ninguna restricción explícita
contra usar Bash para invocar APIs externas de visión. El LLM eligió generar un script
Python inventado en lugar de usar la herramienta `AnalyzeImage` del arnés.

El worker tenía acceso a `Bash` y `AnalyzeImage`, pero sin una regla semántica que
discriminara su uso, eligió el camino hallucinated.

### Fix Aplicado
1. **`src/core/runtime/modelAdapterLite.ts`**: Agregado bloque `REGLAS CRÍTICAS PARA WORKERS`
   en el system prompt del sub-agente que prohíbe explícitamente usar Bash para invocar APIs
   de LLM/visión y obliga a usar `AnalyzeImage`. También exige reporte de error explícito
   si `AnalyzeImage` falla, sin fallback vía Bash.

2. **`src/core/tools/registry.ts`**: Agregada restricción `PROHIBIDO` en la `description` del
   tool `Bash` para bloquear el patrón a nivel de selección de herramienta (doble barrera).

### Verificación
- `npm run build` → 0 errores TypeScript.
- Sistema estable al momento del diagnóstico: sin crashes de daemon, memoria funcionando
  correctamente, Telegram activo.
