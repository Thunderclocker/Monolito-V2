import type { ToolCall } from "./providers/index.ts"

export interface BufferedToolCall {
  toolCall: ToolCall
  index: number          // Posición en el array original de response.toolCalls
}

export class TurnExecutionStack {
  private buffer: BufferedToolCall[] = []
  private executed = new Set<string>()

  /** Registra que una herramienta fue ejecutada con éxito */
  recordSuccess(toolName: string): void {
    this.executed.add(toolName)
  }

  /** Encola un side-effect tool call para ejecución diferida */
  push(toolCall: ToolCall, index: number): void {
    this.buffer.push({ toolCall, index })
  }

  /** Tool calls pendientes de ejecución */
  pending(): BufferedToolCall[] {
    return [...this.buffer]
  }

  /** Herramientas ejecutadas con éxito hasta ahora */
  executedTools(): string[] {
    return [...this.executed]
  }

  /** Limpia el buffer (post-flush o post-rechazo) */
  clearBuffer(): void {
    this.buffer = []
  }

  /** ¿Hay side-effects pendientes? */
  hasPending(): boolean {
    return this.buffer.length > 0
  }
}
