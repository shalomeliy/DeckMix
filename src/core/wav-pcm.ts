/**
 * Reads a WAV's samples as float, for the off-main-thread decoder (v0.9.57). Integer PCM 8/16/24/32-bit and 32/64-bit float, including
 * WAVE_FORMAT_EXTENSIBLE carrying either. Anything else throws with its format code, and the caller uses the browser's decoder instead.
 */
export function readWavPcm(bytes: Uint8Array): { channels: Float32Array[]; sampleRate: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (p: number) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3])
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file')
  let fmt: { code: number; channels: number; rate: number; bits: number } | null = null
  let p = 12
  while (p + 8 <= bytes.length) {
    const id = tag(p)
    const size = dv.getUint32(p + 4, true)
    const body = p + 8
    if (id === 'fmt ') {
      let code = dv.getUint16(body, true)
      if (code === 0xfffe && size >= 40) code = dv.getUint16(body + 24, true) // extensible: the sub-format's first two bytes
      fmt = { code, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) }
    } else if (id === 'data') {
      if (!fmt) throw new Error('data chunk before fmt chunk')
      const end = Math.min(bytes.length, body + size)
      return { channels: deinterleave(dv, body, end, fmt), sampleRate: fmt.rate }
    }
    p = body + size + (size & 1)
  }
  throw new Error('no data chunk')
}

function deinterleave(dv: DataView, start: number, end: number, f: { code: number; channels: number; bits: number }): Float32Array[] {
  const bytesPer = f.bits / 8
  if (!(f.channels > 0) || ![8, 16, 24, 32, 64].includes(f.bits)) throw new Error(`unsupported WAV: ${f.channels} channels, ${f.bits} bits`)
  const isFloat = f.code === 3
  if (!isFloat && f.code !== 1) throw new Error(`unsupported WAV format code ${f.code}`)
  if (isFloat && f.bits !== 32 && f.bits !== 64) throw new Error(`unsupported float WAV: ${f.bits} bits`)
  const frame = bytesPer * f.channels
  const n = Math.floor((end - start) / frame)
  const out = Array.from({ length: f.channels }, () => new Float32Array(n))
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < f.channels; c++) {
      const o = start + i * frame + c * bytesPer
      let v: number
      if (isFloat) v = f.bits === 32 ? dv.getFloat32(o, true) : dv.getFloat64(o, true)
      else if (f.bits === 16) v = dv.getInt16(o, true) / 32768
      else if (f.bits === 24) v = (((dv.getUint8(o + 2) << 24) | (dv.getUint8(o + 1) << 16) | (dv.getUint8(o) << 8)) >> 8) / 8388608
      else if (f.bits === 32) v = dv.getInt32(o, true) / 2147483648
      else v = (dv.getUint8(o) - 128) / 128
      out[c][i] = v
    }
  }
  return out
}
