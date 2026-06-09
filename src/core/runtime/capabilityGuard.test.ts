// Tests for the capability-claim guard.
//
// Bug #8 (09-jun-2026): the agent claimed 'Bash no sale al host' when
// Bash in fact has full host access (verified by `docker ps` running 3
// containers from the runtime CWD). The coherence guard had no way to
// detect the false limitation claim because it had no visibility into
// the registered tools or available bins.

import { test } from "node:test"
import assert from "node:assert/strict"
import { renderCapabilitiesBlock } from "./coherenceGuard.ts"

test("renderCapabilitiesBlock: with no capabilities emits conservative default", () => {
  const block = renderCapabilitiesBlock(undefined)
  assert.match(block, /CAPACIDADES DISPONIBLES/)
  assert.match(block, /snapshot no provisto/)
  // Default bins must be present
  assert.match(block, /docker/)
  assert.match(block, /git/)
  assert.match(block, /ssh/)
})

test("renderCapabilitiesBlock: with tools and bins emits a concrete list", () => {
  const block = renderCapabilitiesBlock({
    tools: [
      { name: "Bash", description: "Execute shell commands" },
      { name: "Read", description: "Read files" },
    ],
    bins: ["docker", "git", "jq"],
  })
  assert.match(block, /Tools registradas:.*Bash.*Read/)
  assert.match(block, /docker.*git.*jq/)
  assert.ok(!block.includes("snapshot no provisto"))
})

test("renderCapabilitiesBlock: empty tool list still renders", () => {
  const block = renderCapabilitiesBlock({ tools: [], bins: [] })
  assert.match(block, /Tools registradas: \(ninguna\)/)
  assert.match(block, /no bin snapshot provided/)
})

test("renderCapabilitiesBlock: contains the key terms the LLM judge needs", () => {
  // The judge is going to parse this block. Make sure the key terms are
  // there in the exact casing expected (the prompt mentions Bash, Read,
  // etc. by name).
  const block = renderCapabilitiesBlock({
    tools: [
      { name: "Bash" },
      { name: "Read" },
      { name: "Edit" },
      { name: "TelegramSendPhoto" },
      { name: "GenerateImage" },
    ],
    bins: ["docker", "git", "ps", "grep"],
  })
  for (const required of ["Bash", "Read", "Edit", "TelegramSendPhoto", "GenerateImage", "docker", "git", "ps", "grep"]) {
    assert.ok(block.includes(required), `block should contain ${required}; got: ${block}`)
  }
})

test("renderCapabilitiesBlock: escapes special characters in tool names safely", () => {
  // Hypothetical: a tool with a quote in its name. The block must not
  // produce a malformed prompt.
  const block = renderCapabilitiesBlock({
    tools: [{ name: 'Tool"WithQuote' }],
    bins: [],
  })
  // The render is plain text interpolation, not template substitution,
  // so a quote in the name should NOT terminate the prompt. As long as
  // the block is readable, the judge is fine.
  assert.ok(block.includes('Tool"WithQuote'))
})
