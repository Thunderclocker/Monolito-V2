import test from "node:test"
import assert from "node:assert/strict"

import { addLogSink, createLogger, setLogLevel, type LogEntry } from "./logger.ts"

test("logger serializes Error objects with message and stack", () => {
  const entries: LogEntry[] = []
  const removeSink = addLogSink(entry => entries.push(entry))
  setLogLevel("debug")

  try {
    const logger = createLogger("test")
    const error = new Error("telegram conflict")
    logger.error("Error en poller de Telegram", error)

    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.message, "Error en poller de Telegram")
    assert.equal(entries[0]?.data?.errorName, "Error")
    assert.equal(entries[0]?.data?.errorMessage, "telegram conflict")
    assert.match(String(entries[0]?.data?.errorStack ?? ""), /telegram conflict/)
  } finally {
    removeSink()
    setLogLevel("info")
  }
})
