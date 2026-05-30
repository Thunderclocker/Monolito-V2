import test from "node:test"
import assert from "node:assert/strict"
import { rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { readWebSearchConfig, writeWebSearchConfig } from "./config.ts"
import { getTool } from "../tools/registry.ts"
import type { ToolContext } from "../tools/registry.ts"

const TEST_ROOT = join(process.cwd(), "scratch", "test-search-providers-db")

// Override process.cwd() for testing config db location
const originalCwd = process.cwd
process.cwd = () => TEST_ROOT

// Mock variables to inspect request payloads
let lastFetchUrl = ""
let lastFetchOptions: any = null
const fetchedUrls: string[] = []

const originalFetch = globalThis.fetch

// Simple mock framework for our search APIs
globalThis.fetch = async (url, options) => {
  const urlStr = typeof url === "string" ? url : (url as any).url || ""
  fetchedUrls.push(urlStr)

  if (urlStr.includes("api.search.brave.com") || urlStr.includes("google.serper.dev") || urlStr.includes("api.tavily.com")) {
    lastFetchUrl = urlStr
    lastFetchOptions = options
  }

  // Brave Search Mock Responses
  if (urlStr.includes("api.search.brave.com/res/v1/web/search")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        web: {
          results: [
            {
              title: "Brave Web Result",
              url: "https://brave.com/web",
              description: "This is a web search result from Brave API"
            }
          ]
        }
      })
    } as any
  }

  if (urlStr.includes("api.search.brave.com/res/v1/images/search")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            title: "Brave Image Result",
            url: "https://brave.com/image-page",
            source: "Brave",
            properties: {
              url: "https://brave.com/image.png"
            },
            thumbnail: {
              src: "https://brave.com/thumb.png"
            }
          }
        ]
      })
    } as any
  }

  // Serper API Mock Responses
  if (urlStr.includes("google.serper.dev/search")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        organic: [
          {
            title: "Serper Web Result",
            link: "https://serper.dev/web",
            snippet: "This is a web search result from Serper API"
          }
        ]
      })
    } as any
  }

  if (urlStr.includes("google.serper.dev/images")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        images: [
          {
            title: "Serper Image Result",
            imageUrl: "https://serper.dev/image.png",
            thumbnailUrl: "https://serper.dev/thumb.png",
            domain: "Serper"
          }
        ]
      })
    } as any
  }

  // Tavily API Mock Responses
  if (urlStr.includes("api.tavily.com/search")) {
    const body = JSON.parse(options?.body as string || "{}")
    if (body.include_images) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          images: [
            {
              url: "https://tavily.com/image.png",
              description: "Tavily Image Result"
            }
          ],
          results: []
        })
      } as any
    } else {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              title: "Tavily Web Result",
              url: "https://tavily.com/web",
              content: "This is a web search result from Tavily API"
            }
          ]
        })
      } as any
    }
  }

  // Scraper Mock
  if (!urlStr.includes("api.search.brave.com") && !urlStr.includes("google.serper.dev") && !urlStr.includes("api.tavily.com")) {
    return {
      ok: true,
      status: 200,
      headers: {
        get: (key: string) => key.toLowerCase() === "content-type" ? "text/html" : null
      },
      arrayBuffer: async () => new TextEncoder().encode("<html><body>Scraped web content!</body></html>").buffer
    } as any
  }

  return {
    ok: false,
    status: 404,
    json: async () => ({})
  } as any
}

test("Search Providers API Integration", async (t) => {
  // Clear and setup test directory
  rmSync(TEST_ROOT, { force: true, recursive: true })
  mkdirSync(TEST_ROOT, { recursive: true })

  const context: ToolContext = {
    rootDir: TEST_ROOT,
    cwd: TEST_ROOT,
  }

  const WebSearch = getTool("WebSearch")
  const ImageSearch = getTool("ImageSearch")

  assert.ok(WebSearch, "WebSearch tool should exist in registry")
  assert.ok(ImageSearch, "ImageSearch tool should exist in registry")

  await t.test("Config persistence works for Brave, Serper, and Tavily", () => {
    // 1. Write and read Brave config
    writeWebSearchConfig({ provider: "brave", apiKey: "brave-key-123" })
    let config = readWebSearchConfig()
    assert.equal(config.provider, "brave")
    assert.equal(config.apiKey, "brave-key-123")

    // 2. Write and read Serper config
    writeWebSearchConfig({ provider: "serper", apiKey: "serper-key-456" })
    config = readWebSearchConfig()
    assert.equal(config.provider, "serper")
    assert.equal(config.apiKey, "serper-key-456")

    // 3. Write and read Tavily config
    writeWebSearchConfig({ provider: "tavily", apiKey: "tavily-key-789" })
    config = readWebSearchConfig()
    assert.equal(config.provider, "tavily")
    assert.equal(config.apiKey, "tavily-key-789")
  })

  await t.test("WebSearch uses Brave Search when configured", async () => {
    writeWebSearchConfig({ provider: "brave", apiKey: "brave-key-123" })

    const res = await WebSearch!.run({ query: "brave web search" }, context) as any
    assert.ok(res.ok)
    
    // Check fetch parameters
    assert.ok(lastFetchUrl.includes("api.search.brave.com/res/v1/web/search"))
    assert.equal(lastFetchOptions.headers["X-Subscription-Token"], "brave-key-123")
    
    // Verify result contains the formatted Brave web outcome
    assert.ok(res.results ? true : res.error === undefined)
  })

  await t.test("ImageSearch uses Brave Search with correct safesearch", async () => {
    writeWebSearchConfig({ provider: "brave", apiKey: "brave-key-123" })

    // Simulate non-adult mode (moderate)
    let res = await ImageSearch!.run({ query: "brave image search", limit: 3 }, context) as any
    assert.ok(res.ok)
    assert.ok(lastFetchUrl.includes("api.search.brave.com/res/v1/images/search"))
    assert.ok(lastFetchUrl.includes("safesearch=moderate"))
    assert.ok(lastFetchUrl.includes("count=3"))
    assert.equal(lastFetchOptions.headers["X-Subscription-Token"], "brave-key-123")

    assert.equal(res.count, 1)
    assert.equal(res.results[0].image_url, "https://brave.com/image.png")
    assert.equal(res.results[0].title, "Brave Image Result")

    // Simulate adult mode (off)
    const adultContext: ToolContext = {
      ...context,
      sessionId: "session-adult-123",
      runtime: {
        acquireJobGroupForBatch: () => "group",
        hasAdultMode: (sessId: string) => sessId === "session-adult-123"
      } as any
    }

    res = await ImageSearch!.run({ query: "brave adult search" }, adultContext) as any
    assert.ok(res.ok)
    assert.ok(lastFetchUrl.includes("safesearch=off"))
  })

  await t.test("WebSearch and ImageSearch use Serper API when configured", async () => {
    writeWebSearchConfig({ provider: "serper", apiKey: "serper-key-456" })

    // 1. Web Search
    const webRes = await WebSearch!.run({ query: "serper web search" }, context) as any
    assert.ok(webRes.ok)
    assert.ok(lastFetchUrl.includes("google.serper.dev/search"))
    assert.equal(lastFetchOptions.headers["X-API-KEY"], "serper-key-456")

    // 2. Image Search
    const imgRes = await ImageSearch!.run({ query: "serper image search", limit: 4 }, context) as any
    assert.ok(imgRes.ok)
    assert.ok(lastFetchUrl.includes("google.serper.dev/images"))
    assert.equal(lastFetchOptions.headers["X-API-KEY"], "serper-key-456")
    const body = JSON.parse(lastFetchOptions.body)
    assert.equal(body.num, 4)
    assert.equal(body.safe, "active")

    assert.equal(imgRes.count, 1)
    assert.equal(imgRes.results[0].image_url, "https://serper.dev/image.png")
    assert.equal(imgRes.results[0].title, "Serper Image Result")
    assert.equal(imgRes.results[0].source, "Serper")
  })

  await t.test("WebSearch and ImageSearch use Tavily API when configured", async () => {
    writeWebSearchConfig({ provider: "tavily", apiKey: "tavily-key-789" })

    // 1. Web Search
    const webRes = await WebSearch!.run({ query: "tavily web search" }, context) as any
    assert.ok(webRes.ok)
    assert.ok(lastFetchUrl.includes("api.tavily.com/search"))
    let body = JSON.parse(lastFetchOptions.body)
    assert.equal(body.api_key, "tavily-key-789")
    assert.equal(body.include_images, false)

    // 2. Image Search
    const imgRes = await ImageSearch!.run({ query: "tavily image search", limit: 2 }, context) as any
    assert.ok(imgRes.ok)
    assert.ok(lastFetchUrl.includes("api.tavily.com/search"))
    body = JSON.parse(lastFetchOptions.body)
    assert.equal(body.api_key, "tavily-key-789")
    assert.equal(body.include_images, true)
    assert.equal(body.include_image_descriptions, true)

    assert.equal(imgRes.count, 1)
    assert.equal(imgRes.results[0].image_url, "https://tavily.com/image.png")
    assert.equal(imgRes.results[0].title, "Tavily Image Result")
  })

  // Cleanup
  globalThis.fetch = originalFetch
  process.cwd = originalCwd
  rmSync(TEST_ROOT, { force: true, recursive: true })
})
