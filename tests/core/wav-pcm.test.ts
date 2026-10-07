import { describe, expect, it } from 'vitest'
import { readWavPcm } from '@/core/wav-pcm'

function wav(code: number, channels: number, bits: number, rate: number, frames: number[][]): Uint8Array {
  const bytesPer = bits / 8
  const data = frames.length * channels * bytesPer
  const buf = new ArrayBuffer(44 + data)
  const dv = new DataView(buf)
  const w = (p: number, s: string) => [...s].forEach((c, i) => dv.setUint8(p + i, c.charCodeAt(0)))
  w(0, 'RIFF'); dv.setUint32(4, 36 + data, true); w(8, 'WAVE')
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, code, true); dv.setUint16(22, channels, true)
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * channels * bytesPer, true); dv.setUint16(32, channels * bytesPer, true); dv.setUint16(34, bits, true)
  w(36, 'data'); dv.setUint32(40, data, true)
  let o = 44
  for (const f of frames) for (const v of f) {
    if (code === 3) dv.setFloat32(o, v, true)
    else if (bits === 16) dv.setInt16(o, Math.round(v * 32767), true)
    else if (bits === 24) { const i = Math.round(v * 8388607); dv.setUint8(o, i & 255); dv.setUint8(o + 1, (i >> 8) & 255); dv.setUint8(o + 2, (i >> 16) & 255) }
    o += bytesPer
  }
  return new Uint8Array(buf)
}

describe('readWavPcm (v0.9.57)', () => {
  it('16-bit stereo comes back as two float channels at the file rate', () => {
    const r = readWavPcm(wav(1, 2, 16, 44100, [[0.5, -0.5], [0.25, 0]]))
    expect(r.sampleRate).toBe(44100)
    expect(r.channels).toHaveLength(2)
    expect(r.channels[0][0]).toBeCloseTo(0.5, 3)
    expect(r.channels[1][0]).toBeCloseTo(-0.5, 3)
    expect(r.channels[0][1]).toBeCloseTo(0.25, 3)
  })
  it('24-bit keeps its sign', () => {
    const r = readWavPcm(wav(1, 1, 24, 48000, [[-0.75], [0.75]]))
    expect(r.channels[0][0]).toBeCloseTo(-0.75, 5)
    expect(r.channels[0][1]).toBeCloseTo(0.75, 5)
  })
  it('32-bit float reads as is', () => {
    const r = readWavPcm(wav(3, 1, 32, 48000, [[0.125]]))
    expect(r.channels[0][0]).toBeCloseTo(0.125, 6)
  })
  it('a format it does not know throws with its code, so the browser decoder takes over', () => {
    expect(() => readWavPcm(wav(2, 1, 16, 44100, [[0]]))).toThrow(/format code 2/)
  })
})
