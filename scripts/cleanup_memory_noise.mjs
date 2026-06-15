#!/usr/bin/env node
/**
 * OBSOLETE — pre-file-backend SQLite maintenance script.
 *
 * Monolito V2 no longer uses memory.sqlite, palace_nodes, or memory_drawers.
 * Keep this file only as historical reference for old deployments.
 *
 * cleanup_memory_noise.mjs
 *
 * Limpia ruido acumulado en memory.sqlite:
 *   1. Marcadores consolidation_*_no_new_content (basura de MemoryAgent)
 *   2. Tareas duplicadas de la ventana/marco (misma tarea, keys distintas)
 *   3. LOG_ACTIONS con más de N días (opcional, --prune-logs=30)
 *
 * Uso:
 *   node scripts/cleanup_memory_noise.mjs [--dry-run] [--prune-logs=30]
 */

import { join } from "node:path"
import { homedir } from "node:os"
import Database from "better-sqlite3"

const DRY_RUN = process.argv.includes("--dry-run")
const pruneLogsArg = process.argv.find(a => a.startsWith("--prune-logs="))
const PRUNE_LOG_DAYS = pruneLogsArg ? parseInt(pruneLogsArg.split("=")[1], 10) : null

const ROOT = process.env.MONOLITO_ROOT ?? join(homedir(), ".monolito")
const DB_PATH = join(ROOT, "memory", "memory.sqlite")

console.log(`DB: ${DB_PATH}`)
if (DRY_RUN) console.log("Modo: DRY-RUN (no se borra nada)")
else console.log("Modo: LIVE (borrando datos reales)")

const db = new Database(DB_PATH)

// ── 1. Contar estado inicial ────────────────────────────────────────────────

const totalDrawers = db.prepare("SELECT COUNT(*) c FROM memory_drawers").get().c
const totalNodes   = db.prepare("SELECT COUNT(*) c FROM palace_nodes").get().c
console.log(`\nEstado inicial: memory_drawers=${totalDrawers}  palace_nodes=${totalNodes}`)

// ── 2. Marcadores no-op de consolidación ───────────────────────────────────

const noopDrawers = db.prepare(`
  SELECT id, wing, memory_key FROM memory_drawers
  WHERE memory_key LIKE 'consolidation_%'
     OR content LIKE '%no_new_content%'
     OR content LIKE '%MEMORY_CONSOLIDATION_TRIGGER%'
     OR content LIKE '%no new substantive%'
`).all()

const noopNodes = db.prepare(`
  SELECT id, wing, node_key FROM palace_nodes
  WHERE node_key LIKE 'consolidation_%'
     OR node_key LIKE 'consolidation_%no_new_content%'
     OR (wing = 'SHARED' AND room = 'session-state')
`).all()

console.log(`\n[1] Marcadores consolidation no-op:`)
console.log(`    memory_drawers: ${noopDrawers.length}`)
console.log(`    palace_nodes  : ${noopNodes.length}`)

if (!DRY_RUN) {
  db.prepare(`
    DELETE FROM memory_drawers
    WHERE memory_key LIKE 'consolidation_%'
       OR content LIKE '%no_new_content%'
       OR content LIKE '%MEMORY_CONSOLIDATION_TRIGGER%'
       OR content LIKE '%no new substantive%'
  `).run()
  db.prepare(`
    DELETE FROM palace_nodes
    WHERE node_key LIKE 'consolidation_%'
       OR (wing = 'SHARED' AND room = 'session-state')
  `).run()
  console.log("    → Borrados.")
}

// ── 3. Dedup de tareas duplicadas (ventana / marco) ─────────────────────────

const DUP_KEYS = [
  "pending_metal_frame_rust_paint",
  "reparar_marco_metalico_oxido",
  "pendiente_ventana",
]

// Las de active_tasks son del tracker cognitivo del agente (TodoWrite),
// no las borramos — solo las de memory_drawers / palace_nodes.

console.log(`\n[2] Dedup de tareas sobre ventana/marco:`)
for (const key of DUP_KEYS) {
  const d = db.prepare("SELECT id FROM memory_drawers WHERE memory_key = ?").all(key)
  const n = db.prepare("SELECT id FROM palace_nodes WHERE node_key = ?").all(key)
  console.log(`    ${key}: drawers=${d.length}  nodes=${n.length}`)
}

// También la tarea stale del psiquiatra que el usuario rechazó
const stalePsiq = db.prepare(`
  SELECT id FROM memory_drawers
  WHERE (memory_key = 'search_psychiatrist_bahia' OR content LIKE '%psiquiatra%Bahía%')
`).all()
console.log(`    search_psychiatrist_bahia (stale, rechazada): ${stalePsiq.length}`)

if (!DRY_RUN) {
  for (const key of DUP_KEYS) {
    // Quedar solo con la más reciente (mayor created_at) si hay más de una
    const rows = db.prepare(`
      SELECT rowid, id FROM memory_drawers WHERE memory_key = ? ORDER BY created_at DESC
    `).all(key)
    if (rows.length > 1) {
      const toDelete = rows.slice(1).map(r => r.id)
      for (const id of toDelete) {
        db.prepare("DELETE FROM memory_drawers WHERE id = ?").run(id)
      }
    }
    db.prepare("DELETE FROM palace_nodes WHERE node_key = ?").run(key)
  }
  db.prepare(`
    DELETE FROM memory_drawers
    WHERE memory_key = 'search_psychiatrist_bahia'
       OR content LIKE '%psiquiatra%Bahía%'
  `).run()
  db.prepare("DELETE FROM palace_nodes WHERE node_key = 'search_psychiatrist_bahia'").run()
  console.log("    → Dedup ejecutado.")
}

// ── 4. Supersede active_tasks cognitivas colgadas ───────────────────────────

const staleActiveTasks = db.prepare(`
  SELECT id, room as session_id, node_key, content
  FROM palace_nodes
  WHERE wing = 'active_tasks'
    AND superseded_at IS NULL
`).all()

const hungTasks = staleActiveTasks.filter(row => {
  try {
    const task = JSON.parse(row.content)
    if (task.category === "life") return false
    return task.status === "pending" || task.status === "in_progress"
  } catch {
    return false
  }
})

console.log(`\n[3] active_tasks cognitivas colgadas (pending/in_progress): ${hungTasks.length}`)
for (const row of hungTasks.slice(0, 10)) {
  const task = JSON.parse(row.content)
  console.log(`    ${row.session_id}/${row.node_key}: [${task.status}] ${task.content?.slice(0, 60)}`)
}
if (hungTasks.length > 10) console.log(`    ... y ${hungTasks.length - 10} más`)

if (!DRY_RUN && hungTasks.length > 0) {
  const now = new Date().toISOString()
  const supersede = db.prepare(`
    UPDATE palace_nodes SET superseded_at = ?
    WHERE id = ? AND superseded_at IS NULL
  `)
  for (const row of hungTasks) {
    supersede.run(now, row.id)
  }
  console.log("    → Supersedidas.")
}

// ── 5. Purga de LOG_ACTIONS viejos (opcional) ───────────────────────────────

if (PRUNE_LOG_DAYS !== null && PRUNE_LOG_DAYS > 0) {
  const cutoff = new Date(Date.now() - PRUNE_LOG_DAYS * 86400_000).toISOString()
  const logDrawers = db.prepare(`
    SELECT COUNT(*) c FROM memory_drawers
    WHERE wing = 'LOG_ACTIONS' AND created_at < ?
  `).get(cutoff).c
  const logNodes = db.prepare(`
    SELECT COUNT(*) c FROM palace_nodes
    WHERE wing = 'LOG_ACTIONS' AND created_at < ?
  `).get(cutoff).c
  console.log(`\n[4] LOG_ACTIONS > ${PRUNE_LOG_DAYS} días: drawers=${logDrawers}  nodes=${logNodes}`)
  if (!DRY_RUN) {
    db.prepare("DELETE FROM memory_drawers WHERE wing = 'LOG_ACTIONS' AND created_at < ?").run(cutoff)
    db.prepare("DELETE FROM palace_nodes WHERE wing = 'LOG_ACTIONS' AND created_at < ?").run(cutoff)
    console.log("    → Purgados.")
  }
}

// ── 6. Estado final ─────────────────────────────────────────────────────────

const finalDrawers = db.prepare("SELECT COUNT(*) c FROM memory_drawers").get().c
const finalNodes   = db.prepare("SELECT COUNT(*) c FROM palace_nodes").get().c
console.log(`\nEstado final: memory_drawers=${finalDrawers}  palace_nodes=${finalNodes}`)
console.log(`Reducción: drawers -${totalDrawers - finalDrawers}  nodes -${totalNodes - finalNodes}`)

db.close()
console.log("\nDone.")
