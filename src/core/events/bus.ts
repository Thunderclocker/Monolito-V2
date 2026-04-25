import { EventEmitter } from "node:events"

export type WorkerCompletedEvent = {
  jobId: string
  sessionId: string
  chatId?: string
  status: "completed" | "failed" | "killed"
  result?: string
  error?: string
}

type MonolitoEventMap = {
  "worker:completed": WorkerCompletedEvent
}

class MonolitoEventBus extends EventEmitter {
  emit<K extends keyof MonolitoEventMap>(event: K, payload: MonolitoEventMap[K]): boolean {
    return super.emit(event, payload)
  }

  on<K extends keyof MonolitoEventMap>(event: K, listener: (payload: MonolitoEventMap[K]) => void): this {
    return super.on(event, listener)
  }

  off<K extends keyof MonolitoEventMap>(event: K, listener: (payload: MonolitoEventMap[K]) => void): this {
    return super.off(event, listener)
  }
}

export const monolitoEvents = new MonolitoEventBus()
