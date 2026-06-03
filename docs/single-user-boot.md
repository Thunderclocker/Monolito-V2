# Single-user BOOT architecture

Monolito V2 enforces a **single-user, multi-profile** model. The BOOT
state — the deterministic identity, user profile, soul, tools, and
memory — is seeded **once**, under the `default` profile, and every
other profile inherits it transparently.

This document explains why, how, and what to watch for.

---

## Why single user

The runtime exists to serve one person. It carries that person's
identity (in `BOOT_SOUL`), profile (in `BOOT_USER`), tool preferences
(in `BOOT_TOOLS`), and durable memory (in `BOOT_MEMORY`). Allowing
those wings to be re-seeded per profile would mean:

- Duplicate identity rows that drift apart over time
- A new profile starting with no context and slowly rediscovering the
  user
- The agent losing track of which user it is talking to

The single-user model solves this by treating the `default` profile as
the canonical source and every other profile as a *role* that acts on
behalf of the same user.

---

## How it works

`palace_nodes` has a `profile_scope` column. Lookup order in
`readLatestPalaceContent` is:

1. The active profile's own row (if any).
2. The `__global__` fallback row (the `default` profile's write).

This means a profile called `Amanda` writing to `BOOT_USER` is the
only thing that gets a custom `BOOT_USER`. Reading `BOOT_USER` from
any profile returns Amanda's row if it exists, else the default.

In practice, agents never write to the `default` wings. They write
their own ephemeral memory into their own profile's palace nodes
(`identity`, `project_facts`, custom wings) and inherit the canonical
user/identity/agent wings from the global fallback.

### The seed is silent

The first time a workspace is created, `ensureBootWings` writes the
canonical content into the `default` profile only. Other profiles
inherit through the lookup chain — they do not have their own rows.
This keeps the storage size flat regardless of how many profiles the
user creates.

---

## Allowed wings

Only seven BOOT wings exist. The tool registry (`BootCreateWing`,
`BootWrite`) refuses to write any other name. The allowed list is in
`src/core/bootstrap/bootWings.ts`:

| Wing             | What lives here                                  |
|------------------|--------------------------------------------------|
| `BOOT_AGENTS`    | Agent profile definitions, delegation rules      |
| `BOOT_SOUL`      | Identity, purpose, principles                    |
| `BOOT_TOOLS`     | Tool-usage conventions, pitfalls to avoid        |
| `BOOT_IDENTITY`  | Visual / external identity metadata              |
| `BOOT_USER`      | User profile (preferences, language, name)       |
| `BOOT_BOOTSTRAP` | First-run onboarding state                       |
| `BOOT_MEMORY`    | Index of durable memory (Palace summary)         |

Attempts to create `BOOT_PERSONALITY`, `BOOT_AI_NAME`, `BOOT_MOOD`, or
any other custom wing are rejected at the tool registry layer. The
runtime logs a `BOOT_CREATE_WING_REJECTED` event.

### Why block custom wings

The seven wings are the only identity-relevant surfaces the agent
should be writing to. If the agent invents a new wing to store some
private taxonomy of "personalities" or "moods", that wing becomes
invisible to other agents and to debugging. Bounding the wing
namespace keeps identity centralized and observable.

If you genuinely need a new identity-relevant surface, the right
move is to add it to the whitelist in `bootWings.ts` and ship a
migration in the same release. Do not bypass the registry.

---

## Profile lifecycle

Profiles are created via `ProfileCreate(name, description)`. The
runtime:

1. Creates a new row in `profiles`.
2. Creates a workspace directory at
   `$MONOLITO_ROOT/profiles/<profile-id>/workspace/`.
3. Does **not** copy any BOOT wings. The profile inherits them via
   the global fallback.

A profile can have its own `BOOT_TOOLS` overrides (e.g. a `coder`
profile with stricter tool rules) by writing its own row, which will
shadow the global one. It cannot delete the global fallback; it can
only shadow it.

To list profiles, use the `AgentList` tool. To inspect what a
profile actually sees at prompt time, run the session with
`monolito -p '/tool system_status'` and inspect the prompt build.

---

## Implications for the agent

When the runtime builds the prompt for a session, the active profile
determines:

- Which palace nodes are read first (own → global)
- Which `BOOT_USER` row to enforce coherence against
- Which `BOOT_TOOLS` rules apply to the tool registry
- Which tool allowlist is in effect

A profile that does not override any of these sees exactly what the
`default` profile sees. This is by design.

If the agent is acting under a non-default profile and behaves
"forgetfully" about the user, the first thing to check is whether
the profile has shadowed a wing with an empty row. Run:

```bash
sqlite3 ~/.monolito/memory/memory.sqlite \
  "SELECT wing, profile_scope, length(content)
   FROM palace_nodes
   WHERE namespace = 'BOOT_WING' AND superseded_at IS NULL
   AND wing IN ('BOOT_USER', 'BOOT_SOUL', 'BOOT_IDENTITY')"
```

If any row has `profile_scope != '__global__'` and a small `content`,
that profile has an override that shadows the canonical version.

---

## Migration story

When a wing is added to the whitelist (e.g. `BOOT_MEMORY` in a
recent release), the migration is:

1. Add the wing name to `BOOT_WING_ORDER` and `DEFAULT_BOOT_WING_CONTENT`
   in `bootWings.ts`.
2. On first run of the new version, `ensureBootWings` detects the
   missing wing and seeds the default content.
3. Existing profiles inherit the seeded content via the global
   fallback.

If you bypass `ensureBootWings` and write a row manually, the new
wing's content lives only under the profile scope you wrote to.
Other profiles will not see it until the global fallback row is
also written.

---

## TL;DR

- Seven BOOT wings, all under `__global__` by default.
- Profiles inherit everything via fallback; they only override what
  they actively write.
- Custom BOOT wings are blocked at the registry. Add to the
  whitelist if you genuinely need one.
- The model is "one user, many roles" — not "many users, one runtime".
