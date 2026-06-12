/**
 * Global Push-to-Talk Hotkey Listener
 *
 * Listens for a configurable X11 keycode (default 49 = º / ordmasculine) via
 * `xinput test-xi2 --root`.  When the key is held down it records audio with
 * `arecord` and plays indicator beeps. On release it transcribes the recording
 * and submits it as a user message to the orchestrator session.
 *
 * Requirements: X11 session (DISPLAY set), `xinput`, `arecord`, and either
 * `pw-play` or `paplay` present in PATH.
 *
 * Fails gracefully when any of these are missing — the daemon starts normally.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { readChannelsConfig } from "../channels/config.ts"
import { transcribeManagedAudioFile, normalizeSttConfig } from "../stt/managed.ts"
import { MONOLITO_ROOT } from "../system/root.ts"
import { createLogger } from "../logging/logger.ts"
import type { MonolitoV2Runtime } from "./runtime.ts"

const execFileAsync = promisify(execFile)
const logger = createLogger("globalHotkey")

/** Default X11 raw keycode for the º (ordmasculine) key on ES/ES-LA layouts. */
const DEFAULT_KEYCODE = 49

/** System sounds to use as push-to-talk indicators (start / stop recording). */
const SOUND_START = "/usr/share/sounds/LinuxMint/stereo/button-toggle-on.ogg"
const SOUND_STOP  = "/usr/share/sounds/LinuxMint/stereo/button-toggle-off.ogg"

// ---------------------------------------------------------------------------
// Audio player helper
// ---------------------------------------------------------------------------

let resolvedPlayer: string | null | undefined = undefined // undefined = not yet detected

async function findAudioPlayer(): Promise<string | null> {
  if (resolvedPlayer !== undefined) return resolvedPlayer
  for (const cmd of ["pw-play", "paplay", "aplay"]) {
    try {
      await execFileAsync("which", [cmd])
      resolvedPlayer = cmd
      return cmd
    } catch {
      // not found, try next
    }
  }
  resolvedPlayer = null
  return null
}

function playSound(path: string) {
  if (!existsSync(path)) return
  void findAudioPlayer().then(player => {
    if (!player) return
    spawn(player, [path], { stdio: "ignore", detached: true }).unref()
  })
}

// ---------------------------------------------------------------------------
// Public service class
// ---------------------------------------------------------------------------

export class GlobalHotkeyService {
  private voiceKeycodes: number[]
  private screenshotKeycodes: number[]
  private screenshotEnabled: boolean
  private runtime: MonolitoV2Runtime
  private xinputProc: ChildProcess | null = null
  private arecordProc: ChildProcess | null = null
  private currentRecordingPath: string | null = null
  private isRecording = false
  private isCapturingScreenshot = false
  private screenshotHotkeyActive = false
  private stopped = false
  private pressedKeys = new Set<number>()

  constructor(
    voiceKeycodes: number[],
    screenshotKeycodes: number[],
    screenshotEnabled: boolean,
    runtime: MonolitoV2Runtime,
  ) {
    this.voiceKeycodes = voiceKeycodes
    this.screenshotKeycodes = screenshotKeycodes
    this.screenshotEnabled = screenshotEnabled
    this.runtime = runtime
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start() {
    if (!process.env.DISPLAY) {
      logger.warn("[GlobalHotkey] DISPLAY not set — hotkey listener disabled.")
      return
    }

    try {
      this.spawnXinput()
    } catch (err) {
      logger.warn(`[GlobalHotkey] Failed to start xinput listener: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  stop() {
    this.stopped = true
    this.stopRecording().catch(() => {})
    if (this.xinputProc) {
      try { this.xinputProc.kill("SIGTERM") } catch {}
      this.xinputProc = null
    }
  }

  // --------------------------------------------------------------------------
  // xinput reader
  // --------------------------------------------------------------------------

  private spawnXinput() {
    const proc = spawn("xinput", ["test-xi2", "--root"], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "ignore"],
    })

    proc.stdout?.setEncoding("utf8")

    let pending = ""

    proc.stdout?.on("data", (chunk: string) => {
      pending += chunk
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""

      for (const line of lines) {
        this.handleXinputLine(line.trim(), (type, detail) => {
          const isVoiceKey = this.voiceKeycodes.includes(detail)
          const isScreenshotKey = this.screenshotKeycodes.includes(detail)
          if (!isVoiceKey && !isScreenshotKey) return

          if (type === "RawKeyPress") {
            this.pressedKeys.add(detail)

            if (this.voiceKeycodes.length > 0) {
              const allVoicePressed = this.voiceKeycodes.every(code => this.pressedKeys.has(code))
              if (allVoicePressed && !this.isRecording) {
                void this.onKeyDown()
              }
            }

            if (this.screenshotEnabled && this.screenshotKeycodes.length > 0) {
              const allScreenshotPressed = this.screenshotKeycodes.every(code => this.pressedKeys.has(code))
              if (allScreenshotPressed) {
                if (!this.screenshotHotkeyActive && !this.isCapturingScreenshot) {
                  this.screenshotHotkeyActive = true
                  void this.onScreenshotHotkeyTriggered()
                }
              }
            }
          } else if (type === "RawKeyRelease") {
            this.pressedKeys.delete(detail)

            if (this.isRecording && this.voiceKeycodes.length > 0) {
              const anyVoiceReleased = this.voiceKeycodes.some(code => !this.pressedKeys.has(code))
              if (anyVoiceReleased) {
                void this.onKeyUp()
              }
            }

            if (this.screenshotHotkeyActive && this.screenshotKeycodes.length > 0) {
              const anyScreenshotReleased = this.screenshotKeycodes.some(code => !this.pressedKeys.has(code))
              if (anyScreenshotReleased) {
                this.screenshotHotkeyActive = false
              }
            }
          }
        })
      }
    })

    proc.on("close", (code) => {
      if (!this.stopped) {
        logger.warn(`[GlobalHotkey] xinput exited with code ${code ?? "?"}, restarting in 3s`)
        setTimeout(() => {
          if (!this.stopped) this.spawnXinput()
        }, 3_000)
      }
    })

    proc.on("error", (err) => {
      logger.warn(`[GlobalHotkey] xinput spawn error: ${err.message}`)
    })

    this.xinputProc = proc
    const screenshotMsg = this.screenshotEnabled
      ? `, screenshot keycodes [${this.screenshotKeycodes.join(", ")}]`
      : ""
    logger.info(`[GlobalHotkey] Listening for voice keycodes [${this.voiceKeycodes.join(", ")}]${screenshotMsg} on DISPLAY=${process.env.DISPLAY}`)
  }

  /**
   * Parses a single line from `xinput test-xi2 --root`.
   * The actual output format (after trim) is:
   *
   *   EVENT type 13 (RawKeyPress)
   *       device: 3 (16)
   *       time:   12345678
   *       detail: 49
   *       flags:
   *
   * The event type line contains the human-readable name in parentheses.
   * We store the pending event type and fire when we see the `detail:` line.
   */
  private _pendingEventType: string | null = null

  private handleXinputLine(line: string, cb: (type: string, detail: number) => void) {
    // Detect event type header: "EVENT type 13 (RawKeyPress)"
    if (line.includes("(RawKeyPress)") || line.includes("(RawKeyRelease)")) {
      this._pendingEventType = line.includes("(RawKeyRelease)") ? "RawKeyRelease" : "RawKeyPress"
      return
    }
    // Reset pending if a new unrelated event type arrives
    if (line.startsWith("EVENT type")) {
      this._pendingEventType = null
      return
    }
    if (this._pendingEventType && line.startsWith("detail:")) {
      const detail = Number.parseInt(line.slice("detail:".length).trim(), 10)
      if (!Number.isNaN(detail)) {
        cb(this._pendingEventType, detail)
      }
      this._pendingEventType = null
    }
  }

  // --------------------------------------------------------------------------
  // Recording
  // --------------------------------------------------------------------------

  private async onKeyDown() {
    if (this.isRecording) return
    this.isRecording = true

    // Play start sound (fire & forget)
    playSound(SOUND_START)

    // Prepare output path
    const scratchDir = join(MONOLITO_ROOT, "scratchpad", "voice-hotkey")
    mkdirSync(scratchDir, { recursive: true })
    const path = join(scratchDir, `recording-${Date.now()}.wav`)
    this.currentRecordingPath = path

    // Start arecord: 16 kHz, mono, 16-bit signed LE (ideal for Whisper STT)
    try {
      const proc = spawn("arecord", [
        "--format=S16_LE",
        "--rate=16000",
        "--channels=1",
        "--file-type=wav",
        path,
      ], { stdio: "ignore" })
      proc.on("error", (err) => {
        logger.warn(`[GlobalHotkey] arecord error: ${err.message}`)
      })
      this.arecordProc = proc
      logger.info(`[GlobalHotkey] Recording started → ${path}`)
    } catch (err) {
      logger.warn(`[GlobalHotkey] Failed to spawn arecord: ${err instanceof Error ? err.message : String(err)}`)
      this.isRecording = false
      this.currentRecordingPath = null
    }
  }

  private async onKeyUp() {
    if (!this.isRecording) return
    await this.stopRecording()
  }

  private async stopRecording() {
    const path = this.currentRecordingPath
    this.isRecording = false
    this.currentRecordingPath = null

    if (this.arecordProc) {
      try { this.arecordProc.kill("SIGTERM") } catch {}
      this.arecordProc = null
    }

    // Play stop sound
    playSound(SOUND_STOP)

    if (!path) return
    if (!existsSync(path)) {
      logger.warn("[GlobalHotkey] Recording file missing, skipping transcription.")
      return
    }

    logger.info(`[GlobalHotkey] Recording stopped. Transcribing ${path}…`)

    try {
      await this.transcribeAndSubmit(path)
    } catch (err) {
      logger.warn(`[GlobalHotkey] Transcription/submit failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      // Clean up the temp file
      try { unlinkSync(path) } catch {}
    }
  }

  // --------------------------------------------------------------------------
  // Screenshot Trigger
  // --------------------------------------------------------------------------

  private async onScreenshotHotkeyTriggered() {
    if (this.isCapturingScreenshot) return
    this.isCapturingScreenshot = true

    // Check for standard camera-shutter sound first, fallback to SOUND_START
    const shutterSound = "/usr/share/sounds/freedesktop/stereo/camera-shutter.oga"
    playSound(existsSync(shutterSound) ? shutterSound : SOUND_START)

    logger.info("[GlobalHotkey] Screenshot hotkey triggered. Capturing screenshot…")

    try {
      // captureScreenshotSilent accepts a profileId (default is "default")
      const path = await this.runtime.captureScreenshotSilent("default")
      if (path && existsSync(path)) {
        logger.info(`[GlobalHotkey] Screenshot captured: ${path}. Buffering silently for next query…`)
        
        playSound(SOUND_STOP)

        this.runtime.bufferScreenshot("orchestrator", path)
      } else {
        logger.warn("[GlobalHotkey] Failed to capture screenshot (path was empty or file missing).")
      }
    } catch (err) {
      logger.warn(`[GlobalHotkey] Screenshot capture failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.isCapturingScreenshot = false
    }
  }

  // --------------------------------------------------------------------------
  // Transcription + submission
  // --------------------------------------------------------------------------

  private async transcribeAndSubmit(audioPath: string) {
    const channelsConfig = readChannelsConfig()
    const sttConfig = normalizeSttConfig(channelsConfig.stt)

    const result = await transcribeManagedAudioFile(audioPath, sttConfig)

    if (!result.ok || !result.text.trim()) {
      logger.warn(`[GlobalHotkey] STT returned empty or failed: ${result.error ?? "empty text"}`)
      return
    }

    const transcript = result.text.trim()
    logger.info(`[GlobalHotkey] Transcribed: "${transcript.slice(0, 120)}"`)

    // Ensure the orchestrator session exists, then send the message
    this.runtime.ensureSession("orchestrator", "Orchestrator")
    await this.runtime.processMessage("orchestrator", transcript)
  }
}

// ---------------------------------------------------------------------------
// Factory — validates environment before constructing
// ---------------------------------------------------------------------------

/**
 * Resolve the configured hotkey and validate the runtime environment.
 * Returns `null` with a warning if the feature cannot be used on this system.
 */
export async function createGlobalHotkeyService(
  runtime: MonolitoV2Runtime,
): Promise<GlobalHotkeyService | null> {
  const config = readChannelsConfig()
  const hotkey = config.hotkey ?? {}
  // Enabled by default — disabled only when hotkey.enabled is explicitly set to false
  const enabled = hotkey.enabled !== false

  if (!enabled) {
    logger.info("[GlobalHotkey] Hotkey explicitly disabled in config (hotkey.enabled=false). Skipping.")
    return null
  }

  if (!process.env.DISPLAY) {
    logger.warn("[GlobalHotkey] DISPLAY env var not set — cannot start X11 hotkey listener.")
    return null
  }

  // Verify xinput is available
  try {
    await execFileAsync("which", ["xinput"])
  } catch {
    logger.warn("[GlobalHotkey] `xinput` not found in PATH — hotkey listener disabled.")
    return null
  }

  // Verify arecord is available
  let hasArecord = true
  try {
    await execFileAsync("which", ["arecord"])
  } catch {
    hasArecord = false
  }

  const voiceKeycodes: number[] = []
  if (hasArecord) {
    if (typeof hotkey.keycode === "number" && hotkey.keycode > 0) {
      voiceKeycodes.push(hotkey.keycode)
    } else if (Array.isArray(hotkey.keycode)) {
      for (const val of hotkey.keycode) {
        if (typeof val === "number" && val > 0) {
          voiceKeycodes.push(val)
        }
      }
    }
    if (voiceKeycodes.length === 0) {
      voiceKeycodes.push(DEFAULT_KEYCODE)
    }
  } else {
    logger.warn("[GlobalHotkey] `arecord` not found in PATH — voice recording hotkey disabled.")
  }

  const screenshotEnabled = hotkey.screenshotEnabled !== false
  const screenshotKeycodes: number[] = []
  if (screenshotEnabled) {
    if (typeof hotkey.screenshotKeycode === "number" && hotkey.screenshotKeycode > 0) {
      screenshotKeycodes.push(hotkey.screenshotKeycode)
    } else if (Array.isArray(hotkey.screenshotKeycode)) {
      for (const val of hotkey.screenshotKeycode) {
        if (typeof val === "number" && val > 0) {
          screenshotKeycodes.push(val)
        }
      }
    }
    if (screenshotKeycodes.length === 0) {
      // Default: Shift + Print Screen (50, 107)
      screenshotKeycodes.push(50, 107)
    }
  }

  return new GlobalHotkeyService(voiceKeycodes, screenshotKeycodes, screenshotEnabled, runtime)
}
