// Secret scanner: detecta credenciales comunes en texto antes de que entren
// a disco via Write/Edit.
//
// upstream parity: subset del `checkTeamMemSecrets` de upstream reference, enfocado en las
// 6 categorías más comunes. Cubre los ataques típicos: leak de API keys
// en código, commit accidentales de private keys, etc.
//
// Análisis de seguridad por omission (lo que NO se detecta aquí):
// - Tokens de providers menos comunes (npm, PyPI, GitLab)
// - Secrets en formatos binarios (PDF, .docx)
// - Encoding ofuscado (base64 wrap, zero-width chars)
// - Secrets partidos en múltiples lines
// Estas categorías quedan como v2.

type SecretPattern = {
  id: string
  regex: RegExp
  description: string
}

const PATTERNS: SecretPattern[] = [
  {
    id: "aws-access-key",
    regex: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
    description: "AWS Access Key ID",
  },
  {
    id: "github-pat-classic",
    regex: /\bghp_[A-Za-z0-9]{36,255}\b/g,
    description: "GitHub Personal Access Token (classic)",
  },
  {
    id: "github-pat-fine-grained",
    regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
    description: "GitHub Fine-Grained Personal Access Token",
  },
  {
    id: "slack-bot-token",
    regex: /\bxox[abposr]-[A-Za-z0-9-]{10,72}\b/g,
    description: "Slack Bot/OAuth Token",
  },
  {
    id: "private-key-pem",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?:\sBLOCK)?-----/g,
    description: "PEM private key header",
  },
  {
    id: "jwt-token",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    description: "JSON Web Token (3-segment)",
  },
]

export type SecretFinding = {
  patternId: string
  description: string
  match: string
  index: number
}

/** Shannon entropy de un string (en bits por carácter). Strings con entropy
 *  > 4.5 bits/chars son probables secrets generados. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of freq.values()) {
    const p = count / s.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

export function scanForSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const pat of PATTERNS) {
    pat.regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pat.regex.exec(content)) !== null) {
      findings.push({
        patternId: pat.id,
        description: pat.description,
        match: m[0].slice(0, 24) + (m[0].length > 24 ? "…" : ""),
        index: m.index,
      })
    }
  }
  return findings
}

/** Heurística adicional: detecta strings de 40+ chars alfanuméricos con
 *  alta entropía que podrían ser API keys no catalogadas. Devuelve findings
 *  sin description específica, marcados como `entropy-high`. */
export function scanHighEntropyStrings(content: string, minLength = 40, threshold = 3.5): SecretFinding[] {
  const findings: SecretFinding[] = []
  const re = /[A-Za-z0-9_\-+/=]{40,}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const candidate = m[0]
    if (shannonEntropy(candidate) >= threshold) {
      findings.push({
        patternId: "entropy-high",
        description: `High-entropy string (${shannonEntropy(candidate).toFixed(2)} bits/char, len=${candidate.length})`,
        match: candidate.slice(0, 24) + "…",
        index: m.index,
      })
    }
  }
  return findings
}

export function isSafeToWrite(content: string): { safe: boolean; findings: SecretFinding[] } {
  const findings = scanForSecrets(content)
  if (findings.length > 0) return { safe: false, findings }
  const highEntropy = scanHighEntropyStrings(content).filter(
    f => !PATTERNS.some(p => p.regex.test(f.match)),
  )
  if (highEntropy.length > 0) return { safe: false, findings: highEntropy }
  return { safe: true, findings: [] }
}
