import type { ProviderResponse } from "./providers/index.ts"

export type DeliveryContext = {
  channel: string
  targetId: string
}

export type DeliveryHandler = (targetId: string, text: string, context: DeliveryContext) => void | Promise<void>

export type AgentYieldEvent =
  | { type: "token"; content: string }
  | { type: "tool_call"; id?: string; name: string; args: Record<string, unknown> }
  | { type: "retry_backoff"; attempt: number; error: string; retryAfterMs: number }
  | { type: "response"; response: ProviderResponse }
