// Encoding detection: detecta UTF-8/UTF-16/ASCII/Latin-1 + line endings.
// FC parity: subset del encoding detection upstream.

export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "ascii" | "latin-1" | "binary"
export type LineEnding = "lf" | "crlf" | "cr" | "mixed" | "none"

export type EncodingInfo = {
  encoding: Encoding
  hasBom: boolean
  bomBytes: number
  lineEnding: LineEnding
  hasNonAscii: boolean
}

const BOM_SIGNATURES: Array<{ encoding: Encoding; bom: number[]; length: number }> = [
  { encoding: "utf-8", bom: [0xef, 0xbb, 0xbf], length: 3 },
  { encoding: "utf-16le", bom: [0xff, 0xfe], length: 2 },
  { encoding: "utf-16be", bom: [0xfe, 0xff], length: 2 },
]

export function detectEncoding(buf: Buffer): EncodingInfo {
  // Check BOMs
  for (const sig of BOM_SIGNATURES) {
    if (buf.length >= sig.length && sig.bom.every((b, i) => buf[i] === b)) {
      return {
        encoding: sig.encoding,
        hasBom: true,
        bomBytes: sig.length,
        lineEnding: detectLineEnding(buf.slice(sig.length)),
        hasNonAscii: true,
      }
    }
  }
  // Heuristic: try to decode as UTF-8
  let isBinary = false
  let hasNonAscii = false
  for (let i = 0; i < Math.min(buf.length, 8 * 1024); i++) {
    const b = buf[i]
    if (b === 0) {
      isBinary = true
      break
    }
    if (b > 127) hasNonAscii = true
  }
  if (isBinary) {
    return {
      encoding: "binary",
      hasBom: false,
      bomBytes: 0,
      lineEnding: "none",
      hasNonAscii: true,
    }
  }
  const encoding: Encoding = hasNonAscii ? "latin-1" : "ascii"
  return {
    encoding,
    hasBom: false,
    bomBytes: 0,
    lineEnding: detectLineEnding(buf),
    hasNonAscii,
  }
}

export function detectLineEnding(buf: Buffer): LineEnding {
  let hasLf = false
  let hasCrlf = false
  let hasCr = false
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (i > 0 && buf[i - 1] === 0x0d) {
        hasCrlf = true
      } else {
        hasLf = true
      }
    } else if (buf[i] === 0x0d) {
      hasCr = true
    }
  }
  const count = (hasLf ? 1 : 0) + (hasCrlf ? 1 : 0) + (hasCr ? 1 : 0)
  if (count === 0) return "none"
  if (count > 1) return "mixed"
  if (hasLf) return "lf"
  if (hasCrlf) return "crlf"
  return "cr"
}

export function decodeBuffer(buf: Buffer, info: EncodingInfo): string {
  if (info.encoding === "utf-8" || info.encoding === "ascii") {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf)
  }
  if (info.encoding === "utf-16le") {
    return new TextDecoder("utf-16le", { fatal: false }).decode(buf)
  }
  if (info.encoding === "utf-16be") {
    return new TextDecoder("utf-16be", { fatal: false }).decode(buf)
  }
  if (info.encoding === "latin-1") {
    return new TextDecoder("iso-8859-1", { fatal: false }).decode(buf)
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf)
}
