// Tests for the audio dedupe helpers. The fix prevents the model from
// regenerating an identical voice/audio after a guard re-feed and
// delivering it twice (observed 2026-06-09 with message_ids 21213 and
// 21215 in the same turn).

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Import the isolated module directly to avoid pulling in the pre-existing
// file.ts / registry.ts circular-reference crash under
// --experimental-strip-types. The same helpers are re-exported from
// internal.ts so production code keeps using the public surface.
const { isAudioAlreadySent, markAudioAsSent, getAlreadySentAudios } = await import("./audioDedupState.ts")

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "monolito-audio-dedup-inner-"))
}

function cleanupRoot(root: string) {
  rmSync(root, { recursive: true, force: true })
}

test("isAudioAlreadySent: returns false for fresh root", () => {
  const root = makeRoot()
  try {
    assert.equal(isAudioAlreadySent(root, "/tmp/audio.ogg"), false)
  } finally { cleanupRoot(root) }
})

test("markAudioAsSent + isAudioAlreadySent: roundtrip", () => {
  const root = makeRoot()
  try {
    const path = "/tmp/some-audio.ogg"
    assert.equal(isAudioAlreadySent(root, path), false)
    markAudioAsSent(root, path)
    assert.equal(isAudioAlreadySent(root, path), true)
  } finally { cleanupRoot(root) }
})

test("markAudioAsSent: is idempotent (re-marking same path doesn't duplicate)", () => {
  const root = makeRoot()
  try {
    const path = "/tmp/audio.ogg"
    markAudioAsSent(root, path)
    markAudioAsSent(root, path)
    markAudioAsSent(root, path)
    const set = getAlreadySentAudios(root)
    assert.equal(set.size, 1)
    assert.ok(set.has(path))
  } finally { cleanupRoot(root) }
})

test("markAudioAsSent: different paths stay independent", () => {
  const root = makeRoot()
  try {
    markAudioAsSent(root, "/tmp/a.ogg")
    markAudioAsSent(root, "/tmp/b.ogg")
    markAudioAsSent(root, "/tmp/c.mp3")
    const set = getAlreadySentAudios(root)
    assert.equal(set.size, 3)
    assert.ok(set.has("/tmp/a.ogg"))
    assert.ok(set.has("/tmp/b.ogg"))
    assert.ok(set.has("/tmp/c.mp3"))
  } finally { cleanupRoot(root) }
})

test("isAudioAlreadySent: independent from photos dedupe set", () => {
  // The audio dedupe state must live in its own file (`telegram_sent_audios.json`)
  // and not collide with `telegram_sent_photos.json`. Regression: the
  // photo dedupe helpers used a different `TELEGRAM_SENT_PHOTOS_KEY`, and
  // these audio helpers must use their own key too.
  const root = makeRoot()
  try {
    markAudioAsSent(root, "/tmp/audio.ogg")
    const set = getAlreadySentAudios(root)
    assert.equal(set.has("/tmp/audio.ogg"), true)
    assert.equal(set.has("/tmp/photo.jpg"), false)
  } finally { cleanupRoot(root) }
})
