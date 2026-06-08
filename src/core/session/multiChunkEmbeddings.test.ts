// Tests para multiChunkEmbeddings.ts
//
// NOTA: estos tests no pegan a Ollama. Cubren el feature flag y la API
// pública que no requiere embeddings reales. La integración con Ollama
// se valida con el daemon en producción (logs `monolitod.log`).
//
// IMPORTANTE: los tests que setean MONOLITO_USE_MULTI_CHUNK_EMBEDDINGS usan
// t.before/t.after para garantizar que el env se restaura incluso si el
// test crashea. Esto evita contaminar otros tests que corren en paralelo
// (especialmente los que llaman recallMemory → embeddings → Ollama).

import test from "node:test"
import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { _resetSchemaCacheForTests } from "../utils/cursor.ts"
import { insertChunkEmbeddings, isMultiChunkEmbeddingsEnabled } from "./multiChunkEmbeddings.ts"

const ENV_KEY = "MONOLITO_USE_MULTI_CHUNK_EMBEDDINGS"

function freshDb(): Database.Database {
  _resetSchemaCacheForTests()
  return new Database(":memory:")
}

test("isMultiChunkEmbeddingsEnabled: defaults to false (env not set)", (t) => {
  const prev = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
  t.after(() => {
    if (prev !== undefined) process.env[ENV_KEY] = prev
    else delete process.env[ENV_KEY]
  })
  assert.equal(isMultiChunkEmbeddingsEnabled(), false)
})

test("isMultiChunkEmbeddingsEnabled: honors env=1, true, yes", (t) => {
  const prev = process.env[ENV_KEY]
  t.after(() => {
    if (prev === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prev
  })
  for (const v of ["1", "true", "yes", "TRUE", "Yes"]) {
    process.env[ENV_KEY] = v
    assert.equal(isMultiChunkEmbeddingsEnabled(), true, `expected true for "${v}"`)
  }
})

test("isMultiChunkEmbeddingsEnabled: rejects env=0, false, no, empty", (t) => {
  const prev = process.env[ENV_KEY]
  t.after(() => {
    if (prev === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prev
  })
  for (const v of ["0", "false", "no", "NO", ""]) {
    process.env[ENV_KEY] = v
    assert.equal(isMultiChunkEmbeddingsEnabled(), false, `expected false for "${v}"`)
  }
})

test("insertChunkEmbeddings: empty input is a no-op (returns 0)", () => {
  const db = freshDb()
  // Without sqlite-vec loaded, the function should still return 0 without
  // touching the table.
  const inserted = insertChunkEmbeddings(db, 1, [])
  assert.equal(inserted, 0)
})


