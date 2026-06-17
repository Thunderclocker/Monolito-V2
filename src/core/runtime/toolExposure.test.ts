import assert from "node:assert/strict"
import test from "node:test"
import {
  buildInitialApiToolAllowlist,
  unlockToolsFromSearchResult,
  boostToolsFromUserText,
} from "./toolExposure.ts"

test("buildInitialApiToolAllowlist includes Web boost for weather", () => {
  const list = buildInitialApiToolAllowlist({ lastUserText: "clima mañana", isTelegramChannel: false })
  assert.ok(list.includes("Web"))
  assert.ok(list.includes("search_tools"))
  assert.ok(list.length < 40)
})

test("unlockToolsFromSearchResult parses native tool lines", () => {
  const content = `Herramientas encontradas:
- [native] CompactSession (direct call: CompactSession(...)): Compact context
- [native] QueryCost (direct call: QueryCost(...)): Token usage`
  assert.deepEqual(unlockToolsFromSearchResult(content), ["CompactSession", "QueryCost"])
})

test("boostToolsFromUserText adds Bash for git tasks", () => {
  assert.ok(boostToolsFromUserText("hacé git commit").includes("Bash"))
})
