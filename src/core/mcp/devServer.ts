type RpcRequest = {
  id?: string
  method: string
  params?: Record<string, unknown>
}

function send(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(request: RpcRequest) {
  switch (request.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: {
            name: "monolito-v2-demo-mcp",
            version: "0.2.0",
          },
        },
      })
      break
    case "notifications/initialized":
      break
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Return the provided text.",
              inputSchema: {
                type: "object",
                properties: {
                  text: { type: "string" },
                },
                required: ["text"],
              },
            },
          ],
        },
      })
      break
    case "tools/call":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: String(request.params?.arguments?.text ?? ""),
            },
          ],
        },
      })
      break
    case "resources/list":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          resources: [
            {
              uri: "monolito://demo/status",
              name: "demo-status",
              description: "Demo MCP resource for Monolito v2.",
            },
          ],
        },
      })
      break
    case "resources/read":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          contents: [
            {
              uri: String(request.params?.uri ?? "monolito://demo/status"),
              mimeType: "text/plain",
              text: "Monolito v2 demo MCP resource is online.",
            },
          ],
        },
      })
      break
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { message: `Unsupported method: ${request.method}` },
      })
  }
}

let buffer = ""
process.stdin.on("data", chunk => {
  buffer += chunk.toString()
  const lines = buffer.split("\n")
  buffer = lines.pop() ?? ""
  for (const line of lines.map(item => item.trim()).filter(Boolean)) {
    handle(JSON.parse(line) as RpcRequest)
  }
})
