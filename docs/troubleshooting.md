# Troubleshooting

Symptom → diagnosis → fix. Each section tells you what the symptom looks
like (in logs, on the CLI, or in Telegram), what to check, and what to do.
Read top to bottom for the most common operational issues.

If you do not see your symptom here, the canonical next step is:

1. `tail -n 200 ~/.monolito/logs/monolitod.log`
2. `monolito /doctor` for an in-app system audit
3. The `SessionForensics` tool for a specific session

---

## Daemon won't start

### Symptom: `monolitod-v2 already running` but `ps` shows nothing

A previous daemon died and left a stale `lock` + `pid` file. The ownership
monitor will not override an existing lockfile unless the socket is also
unresponsive.

**Fix:**

```bash
rm -f /tmp/monolitod-v2-*.sock \
      ~/.monolito/run/monolitod-v2.pid \
      ~/.monolito/run/monolitod-v2.lock \
      ~/.monolito/run/monolitod-v2.owner
monolito
```

### Symptom: `zombie daemon detected — forcing takeover`

A previous daemon left the owner file but the process is gone or
unresponsive. The new daemon will SIGKILL the old PID and clean up.
**No action needed** — the runtime handles this automatically (see
`acquireOwnership` and `probeSocketAlive` in
[`src/core/runtime/daemon.ts`](../src/core/runtime/daemon.ts)).

### Symptom: systemd unit is "active (running)" but `monolito` returns "not running"

Some systemd unit states (`activating`, `deactivating`, `reloading`) make
`is-enabled` and `is-active` both return non-zero, which broke the
self-restart path. The runtime now checks both (commit `274b6d7`) and
falls back to direct spawn when neither succeeds.

**Fix:**

```bash
systemctl --user status monolito.service
systemctl --user reset-failed monolito.service
systemctl --user restart monolito.service
```

If the unit is misconfigured entirely:

```bash
rm ~/.config/systemd/user/monolito.service
systemctl --user daemon-reload
monolito    # re-creates the unit
```

### Symptom: `EADDRINUSE` on the Unix socket

Two daemons tried to bind the same socket. The runtime's
`terminateDuplicateDaemons` should prevent this. If it does not, kill
both and start fresh:

```bash
pkill -f 'monolitod-v2' || true
sleep 1
rm -f /tmp/monolitod-v2-*.sock
monolito
```

---

## Ollama / embeddings unavailable

### Symptom: `Embedding Engine timed out after 30000ms` in the daemon log

The Ollama container did not start in time, or the host cannot reach
`127.0.0.1:11434`.

**Diagnosis:**

```bash
docker ps --filter name=monolito-v2-ollama-embeddings --format "{{.Status}}"
curl -s http://127.0.0.1:11434/api/tags | head -20
```

**Fix (manual deploy):**

```bash
docker start monolito-v2-ollama-embeddings   # if stopped
docker run -d --name monolito-v2-ollama-embeddings \
  -p 11434:11434 -v ~/.monolito/ollama:/root/.ollama \
  ollama/ollama
```

The runtime will retry the warmup on the next daemon restart. Background
embeddings sync (`syncMissingEmbeddings`) catches up on any messages or
Palace writes that landed while Ollama was down.

### Symptom: `Embeddings unavailable` warnings every turn

Embeddings are intentionally **non-fatal**. The runtime degrades to
non-semantic memory recall (last 12 messages, no RAG). The session still
works, but the agent forgets faster across long contexts.

This is a degraded mode, not a bug. The warning is for awareness.

---

## Provider / API errors

### Symptom: `RateLimitError` keeps repeating

The model is rate-limited. The runtime honors `retry-after` if the
provider sends it; otherwise exponential backoff. If the user is
unattended (`MONOLITO_V2_UNATTENDED_RETRY=true`), the runtime will keep
retrying silently.

**Fix for interactive sessions:**

- Wait. The retry state machine caps at a bounded number of attempts.
- Switch to a different model profile with `/model` if the user owns one.

**Fix for unattended contexts:**

- Lower the burst rate (use a smaller model or fewer parallel workers).
- Configure a fallback: set `MONOLITO_V2_FALLBACK_MODEL=provider:model` in
  `.env` to switch automatically after repeated failures.

### Symptom: `ProviderOverloadedError` (503/529)

The provider is down. Same recovery as 429. If you see this from Anthropic,
check <https://status.anthropic.com>. From Grok, the only mitigation is to
wait or fall back to another profile.

### Symptom: HTTP 403 on `auth.x.ai/oauth2/token` (Grok OAuth)

The OAuth account is not authorized for xAI API access. The runtime shows
a specific error:

> *This OAuth account is not authorized for xAI API access — xAI may be
> restricting API/OAuth use to specific SuperGrok tiers despite the
> in-app subscription being active.*

This is not a bug. The Grok API is gated separately from the consumer
subscription. Either upgrade the X Premium+ tier or use a different
provider profile.

### Symptom: `Model request failed (401)` immediately after a successful turn

Auth token expired mid-session. The provider recovery state machine
reloads credentials once before surfacing the error. If it still fails,
the user must re-authenticate (`/model` → pick profile, or
`monolito auth xai-oauth`).

### Symptom: `Context overflow` mid-turn

The model context is exhausted. The Context Engine recovery cascade
fires (see [`memory.md`](./memory.md#context-engine)):

1. Tier 2 LLM compaction on the middle zone
2. Tier 1 in-memory snip on old tool results
3. Reload + retry
4. If 3+ compactions in the same turn → abort, write snapshot to
   `$MONOLITO_ROOT/snapshots/`, surface a clear error.

**If the cascade cannot recover:**

- Start a fresh session with `/new`.
- The user can `/compact [max-messages]` to force compaction earlier.
- Reduce the size of files or images sent in the next session.

### Symptom: a fresh session still overflows immediately

The boot blocks (system + BOOT wings) might be huge. Inspect:

```bash
sqlite3 ~/.monolito/memory/memory.sqlite \
  "SELECT wing, length(content) FROM palace_nodes
   WHERE namespace = 'BOOT_WING' AND superseded_at IS NULL
   ORDER BY length(content) DESC LIMIT 10"
```

Truncate or summarize the largest wings.

---

## Tool execution issues

### Symptom: `Bash` keeps returning non-zero exit codes

If the same command returns the same error twice in a row, the Stall
Guard fires a `STALL_DETECTED` alert. The agent is expected to try a
different path or yield control to the user.

**Diagnostic commands:**

```bash
monolito -p '/status'
# or, from inside a session, use the Bash tool with:
ls -la /path/that/fails
```

If the agent is stuck because the path is genuinely broken (e.g.
permission issue), resolve the permission and resume the session.

### Symptom: tool calls hang forever

The runtime enforces per-turn timeouts (`TURN_HARD_TIMEOUT_MS=95000`).
If a tool call exceeds the timeout, the runtime aborts the turn with a
`TurnTimeoutError` and surfaces a clear error.

If hangs are frequent:

- Check for network partitions (Telegram, SearXNG, Ollama, the model
  provider).
- Check the daemon log for a sequence of long-running tool starts
  without finishes.
- `monolito /status` shows running session ids and their last activity.

### Symptom: `TelegramSendPhoto` returns a path error

Photo delivery expects a local file path. The runtime exposes two
strategies:

- **Telegram `file_id`:** if the photo was previously sent, pass the
  `file_id` directly.
- **HTTP URL:** if the photo is on the public web, pass the URL.
- **Local file:** the path must exist and be readable by the daemon
  process.

For Telegram attachments received by the runtime, the auto-download
sets `local_path` in the `<attachment>` tag. If the attachment was
larger than the auto-download limit (`status="size_limit_exceeded"`),
the agent must call `TelegramDownloadFile` explicitly after asking the
user for confirmation.

---

## Whisper / STT timeouts

### Symptom: `/stt deploy` takes > 45s and the user sees a Telegram error

The Whisper image is large and Docker pull can be slow on a fresh host.

**Fix (commit `19ae1be`):** the deploy timeout was optimized and the
runtime now notifies the user via Telegram when deployment is in
progress, so they do not think the request is lost.

**If the deploy still times out:**

```bash
docker pull onerahmet/openai-whisper-asr-webservice:latest
docker run -d --name monolito-faster-whisper -p 9000:9000 \
  onerahmet/openai-whisper-asr-webservice:latest
```

The runtime will detect the running container on the next
`/stt status` call.

### Symptom: `transcribe` returns empty text

- The audio is silent (VAD filter may have rejected it).
- The model is `tiny` or `base`; try `small` or `medium` for noisy audio.
- The language is wrong. Default is `es`; override with `language=en`
  for English audio.

---

## Vision issues

### Symptom: `VisionAnalyze` returns an empty description

The cloud vision API returned an empty result. The runtime
**automatically falls back** to `AnalyzeImage` (local moondream) in this
case (see `src/core/tools/registry.ts:VisionAnalyze`). The local
fallback is slow (60+ seconds per image on CPU) and will time out on
huge images.

**If both fail:**

```bash
monolito -p '/system_status'   # shows managed vision container state
monolito -p '/system_status --restart vision'
```

---

## Memory / Palace issues

### Symptom: `palace_nodes` growing unbounded

The MemoryAgent and the runtime both write to Palace. There is no
automatic GC. To audit:

```bash
sqlite3 ~/.monolito/memory/memory.sqlite \
  "SELECT wing, room, COUNT(*) FROM palace_nodes
   WHERE superseded_at IS NULL
   GROUP BY wing, room ORDER BY COUNT(*) DESC LIMIT 20"
```

To prune:

```bash
sqlite3 ~/.monolito/memory/memory.sqlite \
  "DELETE FROM palace_nodes WHERE superseded_at IS NOT NULL
   AND superseded_at < datetime('now', '-30 days')"
```

Set up an `anacron` job for the prune if it happens often.

### Symptom: `vec_drawers` integrity check fails on startup

The runtime auto-recreates the vector tables if integrity fails. This is
self-healing (commit `eae9564`). You will see a warning in the daemon
log:

> *Vector tables integrity check failed (will auto-recreate)*

No action needed. Embeddings are regenerated lazily.

### Symptom: `BOOT_USER` was accidentally overwritten with the wrong content

BOOT wings are mutable but versioned. To roll back:

```bash
sqlite3 ~/.monolito/memory/memory.sqlite \
  "SELECT id, content, created_at FROM palace_nodes
   WHERE wing = 'BOOT_USER' ORDER BY created_at DESC LIMIT 5"
```

Then re-write the desired content with `BootWrite` from a fresh session.

---

## Multi-agent / worktree issues

### Symptom: `worktree already exists` on agent spawn

A previous worker left a worktree. The runtime's cleanup is
best-effort. To inspect and remove:

```bash
git worktree list
git worktree remove --force /path/to/stale-worktree
```

### Symptom: a sub-agent is stuck "running" forever

The orchestrator has a 15-minute hard timeout per sub-agent. If the
agent does not respond, the runtime injects a `STALL_DETECTED` and then
kills it.

**If the agent is stuck on a real bug (e.g. waiting for a file that
will never arrive):**

- `monolito -p '/tool AgentStop <agent-id>'` from the CLI, or send
  `/stop <agent-id>` from Telegram.
- Inspect the worker's log: `~/.monolito/logs/instances/worker-*.log`.

---

## Update / restart issues

### Symptom: `/update` failed mid-pull and the daemon is broken

The runtime backs up local changes to a git stash before pulling. On
failure it tries to restore. If that fails:

```bash
cd ~/.monolito/app
git status
git stash list   # find the auto-stash entry
git stash pop    # or git stash drop if you want the new code
```

### Symptom: systemd path detection fails and the daemon respawns the old binary

This used to be a real failure mode (commit `e0f28ad`). The shell
wrapper now properly handles paths with spaces. If you see repeated
restart attempts:

```bash
journalctl --user -u monolito.service -n 50
```

Look for `monolito-restart` helper script invocations. The restart
helper script has a `while kill -0 "$1"; do sleep 0.2; done` loop that
waits for the old daemon to die. If it times out, the rollback branch
fires automatically.

### Symptom: `PATH` is wrong after restart (Node not found)

Commit `2193ea9` prepends the Node binary directory to PATH inside
`runUpdate`. If you still see "Node not found":

- The systemd unit might have its own `Environment=PATH=...` that
  overrides. Edit the unit manually or delete it and let the runtime
  regenerate it.

---

## Performance and cost

### Symptom: `/cost` reports high token usage on simple prompts

The RAG context (12 semantically similar messages + 3 Palace facts) is
appended to the dynamic context on every turn. On sessions with very
long histories and high-similarity churn, RAG can dominate the prompt.

**Mitigations:**

- Lower the RAG budget. Search `runtime.ts` for `getSemanticMessageContext`
  and reduce the `12` and `3` literals.
- Force compaction more aggressively with `/compact 5`.
- Use a smaller model for low-stakes sessions.

### Symptom: Telegram channel is dropping messages

The poller is sequential to avoid duplicate updates and 409 conflicts.
If a message is missed, the runtime does not retry it from the Telegram
side. To replay:

```bash
ssh vps "monolito /sessions"
ssh vps "monolito -p '/tool TelegramSend <chat-id> <text>'"
```

---

## Last-resort diagnostics

If nothing above resolves the issue, capture the following for a
postmortem:

```bash
# 1. Daemon state
monolito /status > /tmp/monolito-status.txt

# 2. Last 500 log lines
tail -n 500 ~/.monolito/logs/monolitod.log > /tmp/monolito-log.txt

# 3. Database health
sqlite3 ~/.monolito/memory/memory.sqlite "PRAGMA integrity_check"
sqlite3 ~/.monolito/memory/memory.sqlite \
  "SELECT type, name FROM sqlite_master ORDER BY type, name" \
  > /tmp/monolito-schema.txt

# 4. Container state
docker ps -a --filter name=monolito > /tmp/monolito-docker.txt
```

Bundle the four files and you have a complete picture of the runtime
state.
