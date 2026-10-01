/**
 * Minimal WAV reading and writing for the training pipeline (v0.12.15). PCM 16/24-bit and
 * 32-bit float only; anything else throws a NAMED error, because the caller must list what it
 * could not read (the project's "never skip silently" rule) rather than drop a file quietly.
 * Chunks are walked, not assumed at fixed offsets: a `LIST` chunk before `data` is normal
 * (the same trap that `tags.ts` records for WAV duration).
 */
export interface Wav {
  channels: Float32Array[]
  sampleRate: number
}

export class WavFormatError extends Error {}

export function encodeWav16(channels: Float32Array[], sampleRate: number): Uint8Array {
  const n = channels[0].length
  const nch = channels.length
  const out = new DataView(new ArrayBuffer(44 + n * nch * 2))
  const tag = (o: number, s: string): void => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)))
  tag(0, 'RIFF')
  out.setUint32(4, 36 + n * nch * 2, true)
  tag(8, 'WAVEfmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true)
  out.setUint16(22, nch, true)
  out.setUint32(24, sampleRate, true)
  out.setUint32(28, sampleRate * nch * 2, true)
  out.setUint16(32, nch * 2, true)
  out.setUint16(34, 16, true)
  tag(36, 'data')
  out.setUint32(40, n * nch * 2, true)
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      out.setInt16(o, Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 32767), true)
      o += 2
    }
  }
  return new Uint8Array(out.buffer)
}

export function decodeWav(bytes: Uint8Array): Wav {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const str = (o: number): string => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
  if (bytes.length < 12 || str(0) !== 'RIFF' || str(8) !== 'WAVE') throw new WavFormatError('not a RIFF/WAVE file')
  let fmt: { tag: number; nch: number; sr: number; bits: number } | null = null
  let pos = 12
  while (pos + 8 <= bytes.length) {
    const id = str(pos)
    const size = v.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = { tag: v.getUint16(body, true), nch: v.getUint16(body + 2, true), sr: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) }
    } else if (id === 'data') {
      if (!fmt) throw new WavFormatError('data chunk before fmt chunk')
      return readSamples(v, body, Math.min(size, bytes.length - body), fmt)
    }
    pos = body + size + (size % 2) // chunks are word-aligned
  }
  throw new WavFormatError('no data chunk')
}

function readSamples(v: DataView, at: number, bytesLen: number, f: { tag: number; nch: number; sr: number; bits: number }): Wav {
  const isFloat = f.tag === 3 && f.bits === 32
  const isPcm = (f.tag === 1 || f.tag === 0xfffe) && (f.bits === 16 || f.bits === 24)
  if (!isFloat && !isPcm) throw new WavFormatError(`unsupported WAV format (tag ${f.tag}, ${f.bits}-bit)`)
  const bps = f.bits / 8
  const n = Math.floor(bytesLen / (bps * f.nch))
  const channels = Array.from({ length: f.nch }, () => new Float32Array(n))
  let o = at
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < f.nch; c++) {
      channels[c][i] = isFloat
        ? v.getFloat32(o, true)
        : f.bits === 16
          ? v.getInt16(o, true) / 32768
          : ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) as number) / 8388608
      o += bps
    }
  }
  return { channels, sampleRate: f.sr }
}
