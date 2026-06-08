// Image processor: detecta si un file es imagen, extrae metadata básica.
// FC parity: subset del imageProcessor.ts upstream. Sin OCR ni resize — solo
// detección + content-type + dimensions via buffer header.

import { readFileSync, statSync } from "node:fs"

export const IMAGE_FORMATS = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "image/avif", "image/svg+xml", "image/bmp",
])

const MAGIC_BYTES: Array<{ ext: string; mime: string; signature: number[] }> = [
  { ext: "jpg", mime: "image/jpeg", signature: [0xff, 0xd8, 0xff] },
  { ext: "png", mime: "image/png", signature: [0x89, 0x50, 0x4e, 0x47] },
  { ext: "gif", mime: "image/gif", signature: [0x47, 0x49, 0x46] },
  { ext: "webp", mime: "image/webp", signature: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  { ext: "bmp", mime: "image/bmp", signature: [0x42, 0x4d] },
]

export type ImageInfo = {
  isImage: boolean
  mime?: string
  ext?: string
  width?: number
  height?: number
  sizeBytes: number
}

export function detectImage(path: string): ImageInfo {
  const stat = statSync(path)
  const sizeBytes = stat.size
  // Read first 16 bytes for magic number detection
  const buf = readFileSync(path).slice(0, 16)
  for (const fmt of MAGIC_BYTES) {
    if (fmt.signature.every((b, i) => buf[i] === b)) {
      // Get dimensions for PNG/JPEG
      let width: number | undefined
      let height: number | undefined
      if (fmt.mime === "image/png" && buf.length >= 24) {
        width = buf.readUInt32BE(16)
        height = buf.readUInt32BE(20)
      } else if (fmt.mime === "image/jpeg" && sizeBytes > 100) {
        // Read enough to find SOF marker
        try {
          const fullBuf = readFileSync(path)
          let offset = 2
          while (offset < fullBuf.length) {
            if (fullBuf[offset] !== 0xff) break
            const marker = fullBuf[offset + 1]
            const segLength = fullBuf.readUInt16BE(offset + 2)
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
              height = fullBuf.readUInt16BE(offset + 5)
              width = fullBuf.readUInt16BE(offset + 7)
              break
            }
            offset += 2 + segLength
          }
        } catch {}
      }
      return { isImage: true, mime: fmt.mime, ext: fmt.ext, width, height, sizeBytes }
    }
  }
  return { isImage: false, sizeBytes }
}
