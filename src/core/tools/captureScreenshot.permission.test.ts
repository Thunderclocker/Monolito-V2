import test from "node:test"
import assert from "node:assert/strict"
import { getTool, isToolSideEffect } from "./registry.ts"

test("CaptureScreenshot is not classified as a read-only operation", () => {
  const tool = getTool("CaptureScreenshot")
  assert.ok(tool, "CaptureScreenshot must be registered")
  assert.equal(tool.permissionTier, "edit")
  assert.equal(isToolSideEffect("CaptureScreenshot"), true)
})
