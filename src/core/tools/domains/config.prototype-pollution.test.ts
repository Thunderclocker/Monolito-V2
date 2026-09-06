import test from "node:test"
import assert from "node:assert/strict"

import { configTools } from "./config.ts"

const manageConfig = configTools.find(tool => tool.name === "tool_manage_config")!

for (const path of [
  "__proto__.polluted",
  "nested.prototype.polluted",
  "nested.constructor.prototype.polluted",
]) {
  test(`tool_manage_config rejects dangerous set path: ${path}`, () => {
    const validationError = manageConfig.validate?.({
      action: "set",
      config: "CONF_CHANNELS",
      path,
      value: true,
    })

    assert.ok(validationError)
  })
}
