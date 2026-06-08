# Security & Parity Status

## Overview

This document tracks the parity status between Monolito V2's tool implementations and
the upstream reference (Free Code / Claude Code's tool harness).

## Parity by Tool

| Tool | Monolito V2 | Upstream | Parity % |
|------|-------------|----------|----------|
| Bash | ~2,800 lines, 18 files, AST + permission gate + 25 security validators + output limits | ~12,400 lines, 18 files | **~45%** |
| Read | ~600 lines, image + encoding + notebook + PDF + dedup + device guard | ~1,418 lines, 4 files | **~55%** |
| Edit | ~700 lines, multi-edit atómico + mtime check + quote normalization + secret guard | ~1,524 lines, 6 files | **~55%** |
| Write | ~250 lines, secret guard + pre-read check + fileHistory | ~452 lines, 3 files | **~50%** |
| Grep | ~210 lines, context lines + type filter + VCS configurable + max_columns | ~595 lines, 3 files | **~50%** |
| MCP | ~600 lines, dynamic facade + per-server allowlists + truncation + isOpenWorld | ~684 lines | **~70%** |
| WebFetch | ~600 lines, LRU cache + redirect validation + preapproved + validateUrlStrict | ~1,060 lines, 5 files | **~62%** |
| WebSearch | ~410 lines, 5 providers + filter translation + recency + allowed/blocked domains | ~469 lines, 3 files | **~95%** |

**Weighted average: ~55% parity.** Main gaps are agent-rewrite pipelines
(Edit), image compression (MCP), and async LLM classifier (Bash).

## Bash Security Validators (25/25)

| # | Rule | Severity | Description |
|---|------|----------|-------------|
| 1 | control_chars | critical | NUL, CR, LF, etc. en command |
| 2 | ifs_injection | high | IFS override |
| 3 | mid_word_hash | medium | `#` en mid-word |
| 4 | brace_expansion | low | `{a,b}` expansion |
| 5 | backslash_escape | medium | `\` al final de line |
| 6 | unicode_whitespace | high | non-ASCII whitespace |
| 7 | dangerous_pattern | critical | curl\|sh, wget\|bash, eval |
| 8 | shell_metachars | low | $ ( ) { } [ ] < > \| & ; ` \ |
| 9 | dangerous_redirection | high | → /etc, /System, ~/.ssh |
| 10 | embedded_newline | high | newline en command |
| 11 | escaped_operator | medium | `\n`, `\t`, `\$` |
| 12 | dangerous_variable | high | LD_PRELOAD, etc. |
| 13 | comment_quote_desync | medium | quote-comment confuso |
| 14 | quoted_newline | medium | `$\n` string escape |
| 15 | cr_injection | high | CR (carriage return) |
| 16 | heredoc_injection | medium | `<<EOF` unquoted |
| 17 | suspicious_env_path | high | env var → /tmp, /dev |
| 18 | proc_subst_fd | low | `<()` process substitution |
| 19 | fork_bomb | critical | `:(){ :\|:& };:` |
| 20 | shebang_in_arg | high | `#!` in command |
| 21 | multi_cd_up | medium | `cd ..; cd ..; cd ..` |
| 22 | chmod_777 | medium | world-writable |
| 23 | find_exec | low | find -exec |
| 24 | xargs_dangerous | high | xargs rm/mv/dd |
| 25 | base64_exec | critical | base64 -d \| sh |

## Destructive Command Detection (10 patterns)

- `rm -rf` on absolute path
- `git reset --hard`, `git clean -f`, `git checkout .`, `git restore .`, `git stash drop`
- `git push --force` / `git push -f`
- `DROP TABLE`, `TRUNCATE TABLE`, `DELETE FROM`
- `kubectl delete`
- `terraform destroy`
- Fork bomb (`:(){ :|:& };:`)

Detected as warnings; do not block execution.

## Bash Permission Gate

### Modes

- `default`: rules in `CONF_POLICY` apply; default-allow if no rules
- `acceptEdits`: filesystem commands auto-allow
- `bypassPermissions`: skip all checks

### Rule Format

```json
{
  "permissions": {
    "mode": "default",
    "rules": [
      { "tool": "Bash", "action": "allow", "prefix": "npm test:*" },
      { "tool": "Bash", "action": "deny", "prefix": "rm -rf *" }
    ]
  }
}
```

### Semantic Rules (opt-in)

Feature flag: `MONOLITO_BASH_SEMANTIC_PERMISSIONS=1`

Rules like `Bash(downloads-and-executes-remote-code:*)` are evaluated via
LLM (Anthropic Claude 3.5 Haiku or Ollama Qwen2.5-1.5B local). Default
classifier returns "unsure" (deny-by-default) for safety.

## MCP Permission System

- `McpInvokeTool` dynamic facade with per-server tool cache
- `isOpenWorld: true` flag enforced via `isMcpPermissionEnabled` for write tools
- `policyConfigZod`-driven rules with `Mcp:<server>:<tool>` keys
- Truncation: 100K char cap with `TRUNCATION_MARKER_PREFIX` insertion

## Things Not Ported (de-scope decisions)

| Feature | Reason |
|---------|--------|
| Sandbox real (bubblewrap/Seatbelt) | Requires OS-level integration, not portable |
| Async LLM classifier default-on | Adds 200-500ms latency per bash call |
| Image compression in MCP | Requires PNG/JPEG re-encoding library |
| Real LSP integration en Read | Monolito tiene LspQuery tool para invocación explícita |
| VSCode notify | Monolito no es VSCode integration |
| Skill discovery from path como active injection | Implementado como función de discovery, no como auto-injection |
| UI React/Ink | Monolito es CLI puro, no aplica |
| Brave silent ignore integration con structured warning | Implementado parcialmente en WebSearch Fase 4 |
| WebFetch image processing inline | Queda en media.ts pipeline |
| Notebook LSP integration en .ipynb | Notebook reader existe; LSP integration es nice-to-have |

## Security Decision Log

| Decision | Date | Rationale |
|----------|------|-----------|
| Default-allow en permission runtime | Fase 0 | No romper flujos existentes; explicit deny siempre gana |
| Soft pre-read warning en Edit/Write | Fase 2 | UX > seguridad dura; warnings visibles |
| Soft pre-read warning en Read (no block) | Fase 1 | Read es read-only, warning informativo |
| Recency filter opt-in | Fase 19 | Provider-dependent; no siempre soportado |
| Semantic classifier opt-in via env | Fase 20 | Latencia no aceptable por default |
| data: URL allowlist en WebFetch | Fase 18 | Necesario para tests/dev |
| 1MB limit en data: URLs | Fase 18 | Tests grandes (CSS repetido) |
| isOpenWorld en MCP con default-allow | Fase 22 | Compat con código existente; explicit policy funciona |

## Test Coverage

- **Total: 380+ tests passing, 0 failing, 4 skipped (rg not installed)**
- Bash: 49 + 16 + 9 = 74 tests
- File state: 7 + 9 = 16 tests
- WebFetch: 11 + 14 = 25 tests
- MCP: 12 + 6 = 18 tests
- WebSearch: 13 tests
- Skill discovery: 8 tests
- Permission runtime: 36 tests

## How to Run the Test Suite

```bash
npm test              # Full suite (~5s)
npm run test:tools    # Tool-specific tests
npm run test:ci       # CI suite
```

## How to Run the E2E Smoke Test

```bash
# Requires ANTHROPIC_API_KEY or equivalent model config
MONOLITO_BASH_SEMANTIC_PERMISSIONS=1 \
npx tsx scripts/test-tools-e2e.ts
```

The E2E test executes a Read→Edit→Bash→Grep sequence via the runtime and
validates each step. Uses a temp `MONOLITO_ROOT` so it doesn't pollute
the real config.

## Next Steps (v2 work)

1. **Bash AST + segmentation improvements** (currently regex-based)
2. **Real sandbox integration** (requires `@anthropic-ai/sandbox-runtime` or build)
3. **Edit agent-rewrite pipeline** (auto-fix malformed edits)
4. **Image compression in MCP truncation**
5. **LSP integration in Read flow** (clear diagnostics post-read)
6. **Sub-agent task lifecycle tools** (FC has TaskCreate/Get/List/Output/Stop/Update as separate tools)
