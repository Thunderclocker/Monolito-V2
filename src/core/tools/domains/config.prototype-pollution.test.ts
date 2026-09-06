import { describe, expect, it } from "vitest"

import { configTools } from "./config.ts"

const manageConfig = configTools.find(tool => tool.name === "tool_manage_config")!

describe("tool_manage_config prototype-pollution guard", () => {
  for (const path of [
    "__proto__.polluted",
    "nested.prototype.polluted",
    "nested.constructor.prototype.polluted",
  ]) {
    it(`rejects dangerous set path: ${path}`, () => {
      const validationError = manageConfig.validate?.({
        action: "set",
        config: "CONF_CHANNELS",
        path,
        value: true,
      })

      expect(validationError).toBeTruthy()
    })
  }
})
