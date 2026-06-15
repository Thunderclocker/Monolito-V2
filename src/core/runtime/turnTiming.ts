import { appendWorklog } from "../session/store.ts"

export type TurnTimingSnapshot = {
  turnPrepMs?: number
  firstTokenMs?: number
  modelInvokeMs?: number
}

export function logTurnPrepTiming(rootDir: string, sessionId: string, turnPrepMs: number, details?: Record<string, number>) {
  const parts = Object.entries(details ?? {}).map(([key, value]) => `${key}=${value}ms`).join(" ")
  appendWorklog(rootDir, sessionId, {
    type: "note",
    summary: `TURN_PREP: ${turnPrepMs}ms${parts ? ` (${parts})` : ""}`,
  })
}

export function logFirstTokenTiming(rootDir: string, sessionId: string, firstTokenMs: number, iteration: number) {
  appendWorklog(rootDir, sessionId, {
    type: "note",
    summary: `FIRST_TOKEN: ${firstTokenMs}ms iteration=${iteration}`,
  })
}

export function logModelInvokeTiming(rootDir: string, sessionId: string, modelInvokeMs: number, iteration: number) {
  appendWorklog(rootDir, sessionId, {
    type: "note",
    summary: `MODEL_INVOKE: ${modelInvokeMs}ms iteration=${iteration}`,
  })
}
