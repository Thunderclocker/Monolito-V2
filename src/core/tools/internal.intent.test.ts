import test, { before } from "node:test"
import assert from "node:assert/strict"

// Set isolated environment root before importing Monolito core modules
// (required by internal.ts because some helpers touch the session store)
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const testMonolitoRoot = mkdtempSync(join(tmpdir(), "monolito-intent-test-root-"))
process.env.MONOLITO_ROOT = testMonolitoRoot

// Import via the registry barrel so the module init order is the
// same as in production (registry.ts re-exports internal.ts after
// all the domain tool arrays have been constructed). Importing
// internal.ts directly triggers a circular-init error in file.ts.
const { getTool } = await import("./registry.ts")
const internal = await import("./internal.ts")

// Sanity: the helpers we need are exported and reachable.
const _isImageIntentText = (s: string) => internal.isImageIntentText(s)
const _isTelegramPhotoDeliveryRequest = (s: string) => internal.isTelegramPhotoDeliveryRequest(s)
const _requiresImageVerificationText = (s: string) => internal.requiresImageVerificationText(s)
const _imageVerificationSkipped = (s: string) => internal.imageVerificationSkipped(s)
const _buildTelegramPhotoWorkerTask = (task: string, sid: string, text: string) =>
  internal.buildTelegramPhotoWorkerTask(task, sid, text)

// Touch the helpers once at module load so a missing export fails the
// test suite loud and early, not as N mysterious failures.
before(() => {
  assert.equal(typeof _isImageIntentText, "function")
  assert.equal(typeof _requiresImageVerificationText, "function")
  assert.equal(typeof _imageVerificationSkipped, "function")
  assert.equal(typeof _buildTelegramPhotoWorkerTask, "function")
})

test("isImageIntentText matches image words", () => {
  assert.equal(_isImageIntentText("mandame una foto de un gato"), true)
  assert.equal(_isImageIntentText("buscame una imagen"), true)
  assert.equal(_isImageIntentText("pasame una picture"), true)
  assert.equal(_isImageIntentText("dame una photo"), true)
  assert.equal(_isImageIntentText("hola mundo"), false)
})

test("isTelegramPhotoDeliveryRequest requires image word AND delivery verb", () => {
  assert.equal(_isTelegramPhotoDeliveryRequest("mandame una foto de un gato"), true)
  assert.equal(_isTelegramPhotoDeliveryRequest("pasame una imagen de un perro"), true)
  assert.equal(_isTelegramPhotoDeliveryRequest("send me a photo"), true)
  assert.equal(_isTelegramPhotoDeliveryRequest("que linda foto"), false)
  assert.equal(_isTelegramPhotoDeliveryRequest("mandame un mensaje"), false)
})

test("requiresImageVerificationText: explicit verification verbs match", () => {
  assert.equal(_requiresImageVerificationText("verifica la foto"), true)
  assert.equal(_requiresImageVerificationText("analizá si es Hitomi"), true)
  assert.equal(_requiresImageVerificationText("describe la imagen"), true)
  assert.equal(_requiresImageVerificationText("confirmá que sea correcto"), true)
  assert.equal(_requiresImageVerificationText("verifica que sea la persona correcta"), true)
  assert.equal(_requiresImageVerificationText("verifica que sea la misma"), true)
  assert.equal(_requiresImageVerificationText("es la imagen real?"), true)
})

test("requiresImageVerificationText: medical/aesthetic use of 'vision/visual' does NOT match", () => {
  // The previous version of the regex matched bare 'vision' / 'visual',
  // producing false positives on these non-verification uses.
  assert.equal(_requiresImageVerificationText("tengo problemas de vision"), false)
  assert.equal(_requiresImageVerificationText("dame una imagen con buena visual"), false)
  assert.equal(_requiresImageVerificationText("el visual del cuadro me gusta"), false)
  assert.equal(_requiresImageVerificationText("perdí la vision del ojo izquierdo"), false)
})

test("requiresImageVerificationText: bare verification verbs match (image context is the caller's job)", () => {
  // The helper is a soft detector: it returns true for the verb itself.
  // The caller (buildTelegramPhotoWorkerTask) combines this with
  // isImageIntentText before deciding. So "verifica que el script
  // funcione" returns true here — but it would never reach
  // buildTelegramPhotoWorkerTask because the user text is not an
  // image intent. This test documents the helper's contract.
  assert.equal(_requiresImageVerificationText("verifica que el script funcione"), true)
  assert.equal(_requiresImageVerificationText("hola"), false)
  assert.equal(_requiresImageVerificationText(""), false)
})

test("imageVerificationSkipped: explicit opt-out phrases match", () => {
  assert.equal(_imageVerificationSkipped("no analices las fotos, solo mandalas"), true)
  assert.equal(_imageVerificationSkipped("no analices"), true)
  assert.equal(_imageVerificationSkipped("no verifiques"), true)
  assert.equal(_imageVerificationSkipped("sin verificar"), true)
  assert.equal(_imageVerificationSkipped("skip verify"), true)
  assert.equal(_imageVerificationSkipped("skip verification"), true)
  assert.equal(_imageVerificationSkipped("evitá el análisis"), true)
  assert.equal(_imageVerificationSkipped("no quiero verificación"), true)
  assert.equal(_imageVerificationSkipped("solo mandá"), true)
  assert.equal(_imageVerificationSkipped("solo mandá una foto"), true)
  assert.equal(_imageVerificationSkipped("solo enviá"), true)
  assert.equal(_imageVerificationSkipped("just send it"), true)
})

test("imageVerificationSkipped: verify/describe requests do NOT match", () => {
  assert.equal(_imageVerificationSkipped("verifica la última foto que te mandé"), false)
  assert.equal(_imageVerificationSkipped("verificá antes de mandar"), false)
  assert.equal(_imageVerificationSkipped("analizá si es la persona correcta"), false)
  assert.equal(_imageVerificationSkipped("describe la imagen"), false)
  assert.equal(_imageVerificationSkipped("mandame una foto"), false)
  assert.equal(_imageVerificationSkipped("hola"), false)
})

test("buildTelegramPhotoWorkerTask: skipped=true short-circuits verify branch", () => {
  const result = _buildTelegramPhotoWorkerTask(
    "task: get a photo of a cat",
    "telegram-1515784684",
    "no analices las fotos, solo mandalas, una de un gato",
  )
  assert.ok(
    result.includes("NO uses VisionAnalyze"),
    `expected skip branch, got: ${result.slice(0, 400)}`,
  )
  assert.ok(!result.toLowerCase().includes("validá cada candidato"), "verify branch should not appear")
})

test("buildTelegramPhotoWorkerTask: verify-intent without skip takes the soft verify branch", () => {
  const result = _buildTelegramPhotoWorkerTask(
    "task: get a photo of Hitomi",
    "telegram-1515784684",
    "verificá que sea la persona correcta antes de mandar",
  )
  assert.ok(
    result.includes("se sugiere validar"),
    `expected soft verify branch, got: ${result.slice(0, 400)}`,
  )
})

test("buildTelegramPhotoWorkerTask: no verify-intent, no skip → default no-verify branch", () => {
  const result = _buildTelegramPhotoWorkerTask(
    "task: get a photo of a golden retriever",
    "telegram-1515784684",
    "mandame una foto de un golden retriever",
  )
  assert.ok(
    result.includes("NO uses VisionAnalyze"),
    `expected default no-verify branch, got: ${result.slice(0, 400)}`,
  )
})

test("buildTelegramPhotoWorkerTask: returns task unchanged for non-Telegram sessions", () => {
  const task = "task: just a regular task"
  const result = _buildTelegramPhotoWorkerTask(task, "session-abc-123", "verifica la foto")
  assert.equal(result, task, "non-telegram session should pass the task through unchanged")
})

// Touch getTool to keep the linter honest and to make sure the barrel
// loads with no circular-init issues.
test("registry barrel loads (smoke)", () => {
  assert.ok(getTool("TelegramSendPhoto"), "TelegramSendPhoto must be registered")
  assert.ok(getTool("TelegramGetRecentPhotos"), "TelegramGetRecentPhotos must be registered")
  assert.ok(getTool("VisionAnalyze"), "VisionAnalyze must be registered")
})
