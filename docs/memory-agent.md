# Memory Agent

The background `Memory Agent` reviews conversation after the main reply is already done and decides whether something should be remembered for future interactions.

## Purpose

The goal is to let Monolito learn useful user context without interrupting the main chat flow and without pushing everything into the most canonical memory files.

The agent should be conservative with core memory and more permissive with Memory Palace entries.

## Triggers

The `Memory Agent` runs in the background at these moments:

- After normal turns (`post-turn`)
- Before `/compact` rewrites older session history (`pre-compact`)
- Before session resets such as `/new` (`session-end`)

## Memory destinations

### `USER.md`

Use `USER.md` for stable facts about the person:

- communication preferences
- preferred language
- tone and style preferences
- boundaries
- recurring habits
- stable preferences about how the assistant should behave

This is the strictest destination.

### `MEMORY.md`

Use `MEMORY.md` for durable relational context:

- repeated long-term goals
- important ongoing life context
- long-lived interaction patterns
- durable context that should stay visible across many future conversations

This is also strict, but it is about the relationship and long-running context more than personal profile.

### Memory Palace

Use Memory Palace for useful but less canonical context:

- plans
- worries
- current situations
- medium-term intentions
- contextual facts that may help later
- tentative personal signals that are worth recalling, but not important enough for `USER.md` or `MEMORY.md`

This is the cheapest place to remember something. It should accept useful context even when it is not fully stable.

## Routing guidelines

- Highly stable and identity-level: `USER.md`
- Durable and important across many future conversations: `MEMORY.md`
- Useful later, but not stable or central enough for the core files: Memory Palace
- Trivial or low-value context: do not save it

## Contradictions

If new information clearly updates or contradicts an existing line in `USER.md` or `MEMORY.md`, the agent should prefer a replace-style update instead of accumulating both versions.

If the contradiction is weak or uncertain, the safer fallback is Memory Palace or no write.

## Writing style

Stored memories should be:

- short
- atomic
- factual
- close to the user's wording
- in the same language used by the user

The agent should avoid:

- speculative conclusions
- assistant advice mixed into the memory
- invented needs or future actions
- verbose summaries

## Logging

The `Memory Agent` writes a dedicated log at:

` .monolito-v2/logs/memory-agent.log `

Typical events include:

- `review.start`
- `review.model_response`
- `proposal.applied`
- `proposal.skip`
- `review.done`
- `review.noop`

If the agent applies a change, Monolito also appends a summary to the session worklog.
