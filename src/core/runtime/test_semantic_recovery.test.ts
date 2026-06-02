import test, { after } from "node:test"
import assert from "node:assert/strict"
import { rmSync, mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Set isolated environment root before importing Monolito core modules
const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-recovery-test-root-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

// Dynamically import the core modules so they pick up the environment variable
const { setMockEmbeddingGenerator } = await import("../session/embeddings.ts")
const { saveResolvedError, querySimilarErrors, getDb } = await import("../session/store.ts")

const TEST_ROOT = testMonolitoRoot

after(() => {
  rmSync(testMonolitoRoot, { recursive: true, force: true })
})

// Configurar un Mock Generator de embeddings de 1024 dimensiones
setMockEmbeddingGenerator(async (text) => {
  const arr = new Float32Array(1024)
  // Lógica simple: colocar un valor distintivo según palabras clave para simular distancias semánticas
  if (text.includes("TypeError")) {
    arr[0] = 1.0
  } else if (text.includes("SyntaxError")) {
    arr[1] = 1.0
  } else {
    arr[2] = 1.0
  }
  
  // Normalizar el vector
  let sum = 0
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i] * arr[i]
  }
  const mag = Math.sqrt(sum)
  if (mag > 0) {
    for (let i = 0; i < arr.length; i++) arr[i] /= mag
  }
  return arr
})

test("saveResolvedError and querySimilarErrors learn and recover errors semantically", async () => {
  // Asegurar directorio limpio para el test
  rmSync(TEST_ROOT, { force: true, recursive: true })
  mkdirSync(TEST_ROOT, { recursive: true })

  // Inicializar DB
  const db = getDb(TEST_ROOT)

  // 1. Registrar un error de TypeError y su solución
  await saveResolvedError(
    TEST_ROOT,
    "TypeError: Cannot read properties of undefined (reading 'split')",
    "Verify the input is a string before calling split(), or use optional chaining input?.split()"
  )

  // 2. Registrar un error de SyntaxError y su solución
  await saveResolvedError(
    TEST_ROOT,
    "SyntaxError: Unexpected token < in JSON at position 0",
    "The API returned HTML instead of JSON. Ensure the endpoint and accept headers are correct."
  )

  // 3. Consultar semánticamente un error similar a TypeError
  const match1 = await querySimilarErrors(
    TEST_ROOT,
    "TypeError: undefined reading split" // Variación semántica
  )

  assert.ok(match1)
  assert.equal(match1.error, "TypeError: Cannot read properties of undefined (reading 'split')")
  assert.ok(match1.solution.includes("optional chaining"))

  // 4. Consultar semánticamente un error similar a SyntaxError
  const match2 = await querySimilarErrors(
    TEST_ROOT,
    "SyntaxError: unexpected < character in json" // Variación semántica
  )

  assert.ok(match2)
  assert.equal(match2.error, "SyntaxError: Unexpected token < in JSON at position 0")
  assert.ok(match2.solution.includes("HTML instead of JSON"))

  // 5. Consultar un error que no tiene nada que ver (debe dar null por umbral de distancia)
  const match3 = await querySimilarErrors(
    TEST_ROOT,
    "UnknownError: Something went totally wrong on port 8080"
  )

  assert.equal(match3, null)

  // Limpiar
  db.close()
  rmSync(TEST_ROOT, { force: true, recursive: true })
})
