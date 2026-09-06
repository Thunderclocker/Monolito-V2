import assert from "node:assert/strict"
import test from "node:test"

import { SseMcpClient } from "./client.js"

type TestableSseClient = {
  handleSseEvent(rawEvent: string): void
  endpointUrl: string | null
}

function asTestable(client: SseMcpClient): TestableSseClient {
  return client as unknown as TestableSseClient
}

test("SSE endpoint announcement rejects loopback pivot", () => {
  const client = new SseMcpClient("https://mcp.example.test/sse")
  const testable = asTestable(client)

  assert.throws(
    () => testable.handleSseEvent("event: endpoint\ndata: http://127.0.0.1:8080/messages"),
    /endpoint|origin|private|loopback/i,
  )
  assert.equal(testable.endpointUrl, null)
})

test("SSE endpoint announcement rejects cross-origin public pivot", () => {
  const client = new SseMcpClient("https://mcp.example.test/sse")
  const testable = asTestable(client)

  assert.throws(
    () => testable.handleSseEvent("event: endpoint\ndata: https://attacker.example/messages"),
    /endpoint|origin/i,
  )
  assert.equal(testable.endpointUrl, null)
})

test("SSE endpoint announcement accepts same-origin relative endpoint", () => {
  const client = new SseMcpClient("https://mcp.example.test/sse")
  const testable = asTestable(client)

  testable.handleSseEvent("event: endpoint\ndata: /messages")
  assert.equal(testable.endpointUrl, "https://mcp.example.test/messages")
})
