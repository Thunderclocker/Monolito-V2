// Tests para mcp-collapse.ts + mcp-truncation.ts

import test from "node:test"
import assert from "node:assert/strict"
import {
  classifyMcpToolForCollapse,
  normalizeMcpToolName,
  isReadOnlyMcpTool,
} from "./mcp-collapse.ts"
import {
  roughTokenCount,
  mcpContentNeedsTruncation,
  truncateMcpContent,
  DEFAULT_TOKEN_BUDGET,
} from "./mcp-truncation.ts"

test("classifyMcpToolForCollapse: list_*, search_*, find_* → search", () => {
  assert.equal(classifyMcpToolForCollapse("list_users"), "search")
  assert.equal(classifyMcpToolForCollapse("search_repos"), "search")
  assert.equal(classifyMcpToolForCollapse("find_issues"), "search")
})

test("classifyMcpToolForCollapse: get_* → read", () => {
  assert.equal(classifyMcpToolForCollapse("get_user"), "read")
  assert.equal(classifyMcpToolForCollapse("get_repo_metadata"), "read")
})

test("classifyMcpToolForCollapse: create/update/delete/send → write", () => {
  assert.equal(classifyMcpToolForCollapse("create_issue"), "write")
  assert.equal(classifyMcpToolForCollapse("update_pr"), "write")
  assert.equal(classifyMcpToolForCollapse("delete_file"), "write")
  assert.equal(classifyMcpToolForCollapse("send_message"), "write")
})

test("classifyMcpToolForCollapse: unknown → default", () => {
  assert.equal(classifyMcpToolForCollapse("weird_tool"), "default")
  assert.equal(classifyMcpToolForCollapse(""), "default")
})

test("normalizeMcpToolName converts kebab to snake and camelCase", () => {
  assert.equal(normalizeMcpToolName("list-users"), "list_users")
  assert.equal(normalizeMcpToolName("getUserInfo"), "get_user_info")
  assert.equal(normalizeMcpToolName("already_snake"), "already_snake")
  assert.equal(normalizeMcpToolName("MixedCase"), "mixed_case")
})

test("isReadOnlyMcpTool true for search/read", () => {
  assert.equal(isReadOnlyMcpTool("list_users"), true)
  assert.equal(isReadOnlyMcpTool("get_repo"), true)
  assert.equal(isReadOnlyMcpTool("create_issue"), false)
  assert.equal(isReadOnlyMcpTool("delete_file"), false)
})

test("roughTokenCount uses chars/4", () => {
  assert.equal(roughTokenCount(""), 0)
  assert.equal(roughTokenCount("abcd"), 1)
  assert.equal(roughTokenCount("a".repeat(100)), 25)
})

test("mcpContentNeedsTruncation: small content returns false", () => {
  assert.equal(mcpContentNeedsTruncation("hello"), false)
  assert.equal(mcpContentNeedsTruncation("a".repeat(1000)), false)
})

test("mcpContentNeedsTruncation: huge content returns true", () => {
  const big = "a".repeat(DEFAULT_TOKEN_BUDGET * 4 + 100)
  assert.equal(mcpContentNeedsTruncation(big), true)
})

test("truncateMcpContent returns original if under budget", () => {
  const small = "hello world"
  assert.equal(truncateMcpContent(small), small)
})

test("truncateMcpContent truncates with marker if over budget", () => {
  const big = "a".repeat(200_000)
  const out = truncateMcpContent(big, 100) // budget 100 = maxChars 400
  assert.match(out, /truncated/)
  assert.ok(out.length < big.length)
  assert.ok(out.length > 400) // includes marker
})

test("truncateMcpContent with custom budget", () => {
  const content = "x".repeat(1000)
  const out = truncateMcpContent(content, 10) // maxChars 40
  assert.match(out, /truncated/)
})
