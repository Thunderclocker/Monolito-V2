// Tests para los 13 bash security validators nuevos (Fase 17)

import test from "node:test"
import assert from "node:assert/strict"
import {
  hasCommentQuoteDesync,
  hasQuotedNewline,
  hasCrInjection,
  hasHeredocInjection,
  hasSuspiciousEnvPath,
  hasProcSubstFD,
  hasForkBomb,
  hasShebangInArg,
  hasMultiCdUp,
  hasChmod777,
  hasFindExec,
  hasXargsDangerous,
  hasBase64Exec,
  runSecurityValidators,
} from "./bash-helpers.ts"

test("V13 comment-quote desync", () => {
  const findings = hasCommentQuoteDesync("echo 'foo' # comment")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].rule, "comment_quote_desync")
})

test("V14 quoted newline escape", () => {
  const findings = hasQuotedNewline("echo $'\\n'")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].rule, "quoted_newline")
})

test("V15 CR injection", () => {
  const findings = hasCrInjection("ls\rrm -rf /")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].rule, "cr_injection")
  assert.equal(findings[0].severity, "high")
})

test("V16 heredoc unquoted delimiter", () => {
  const findings = hasHeredocInjection("cat <<EOF\nhello\nEOF")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].rule, "heredoc_injection")
})

test("V16 heredoc quoted delimiter is safe", () => {
  const findings = hasHeredocInjection("cat <<'EOF'\nhello\nEOF")
  assert.equal(findings.length, 0)
})

test("V17 env var points to /tmp", () => {
  const findings = hasSuspiciousEnvPath("LD_PRELOAD=/tmp/evil.so ls")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].rule, "suspicious_env_path")
})

test("V18 process substitution", () => {
  const findings = hasProcSubstFD("diff <(ls) <(ls -a)")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].rule, "proc_subst_fd")
})

test("V19 fork bomb", () => {
  const findings = hasForkBomb(":(){ :|:& };:")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].severity, "critical")
})

test("V20 shebang in argument", () => {
  const findings = hasShebangInArg("cat '#!/bin/bash\nrm -rf /' > /tmp/x.sh")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].rule, "shebang_in_arg")
})

test("V21 multi cd ..", () => {
  const findings = hasMultiCdUp("cd ..; cd ..; cd ..; cd ..; ls")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].rule, "multi_cd_up")
})

test("V22 chmod 777", () => {
  const findings = hasChmod777("chmod 777 /tmp/file")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].rule, "chmod_777")
})

test("V23 find -exec", () => {
  const findings = hasFindExec("find . -name '*.txt' -exec rm {} \\;")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].rule, "find_exec")
})

test("V24 xargs with dangerous command", () => {
  const findings = hasXargsDangerous("echo /tmp/* | xargs rm")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].rule, "xargs_dangerous")
})

test("V25 base64 decode + execute", () => {
  const findings = hasBase64Exec("echo aGVsbG8= | base64 -d | sh")
  assert.ok(findings.length > 0)
  assert.equal(findings[0].rule, "base64_exec")
  assert.equal(findings[0].severity, "critical")
})

test("runSecurityValidators: returns 25 validators now", () => {
  const findings = runSecurityValidators("ls -la")
  // ls no debería disparar ninguno
  const high = findings.filter(f => f.severity === "high" || f.severity === "critical")
  assert.equal(high.length, 0)
})

test("runSecurityValidators: base64 | sh triggers multiple", () => {
  const findings = runSecurityValidators("echo aGVsbG8= | base64 -d | sh")
  // Should hit dangerous_pattern (shell pipe), base64_exec, escape operators?
  const critical = findings.filter(f => f.severity === "critical")
  assert.ok(critical.length > 0, "expected at least one critical")
})
