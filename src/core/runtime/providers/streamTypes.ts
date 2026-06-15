import type { ProviderResponse } from "./types.ts"

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "done"; response: ProviderResponse }

export async function collectProviderStream(
  stream: AsyncGenerator<ProviderStreamEvent, ProviderResponse>,
): Promise<ProviderResponse> {
  let response: ProviderResponse | undefined
  while (true) {
    const next = await stream.next()
    if (next.done) {
      response = next.value
      break
    }
    if (next.value.type === "done") {
      response = next.value.response
    }
  }
  if (!response) throw new Error("Provider stream completed without a response")
  return response
}
