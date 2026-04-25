import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { getDb } from "../src/core/session/store.ts"

const rootDir = process.cwd()
const db = getDb(rootDir)
const migrationsDir = join(rootDir, "src/core/db/migrations")

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`)

const applied = new Set(
  (db.prepare(`SELECT name FROM schema_migrations`).all() as Array<{ name: string }>)
    .map(row => row.name),
)

const files = readdirSync(migrationsDir)
  .filter(name => name.endsWith(".sql"))
  .sort()

for (const file of files) {
  if (applied.has(file)) continue
  const sql = readFileSync(join(migrationsDir, file), "utf8")
  db.exec("BEGIN TRANSACTION")
  try {
    db.exec(sql)
    db.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`)
      .run(file, new Date().toISOString())
    db.exec("COMMIT")
    process.stdout.write(`applied ${file}\n`)
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

if (files.every(file => applied.has(file))) {
  process.stdout.write("database already up to date\n")
}
