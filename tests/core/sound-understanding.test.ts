import { describe, expect, it } from 'vitest'
import { fft, stftMagnitude } from '@/core/spectrogram'
import { hpssFrames } from '@/core/hpss'
import { stereoCentre } from '@/core/stereo-centre'

const SR = 22050

function mean(a: Float32Array, from = 0, to = a.length): number {
  let s = 0
  for (let i = from; i < to; i++) s += a[i]
  return s / (to - from)
}

/** Steady chord: stable in time, narrow in frequency — what a pad or bassline looks like. */
function tones(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    out[i] = 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.3 * Math.sin(2 * Math.PI * 660 * t) + 0.3 * Math.sin(2 * Math.PI * 1320 * t)
  }
  return out
}

/** Broadband clicks — short in time, wide in frequency, like a hat or clap. */
function clicks(seconds: number, everySec: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  let seed = 12345
  for (let c = 0; c * everySec < seconds; c++) {
    const at = Math.round(c * everySec * SR)
    for (let i = 0; i < 64 && at + i < out.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      out[at + i] = ((seed / 0xffffffff) * 2 - 1) * 0.9
    }
  }
  return out
}

describe('fft', () => {
  it('puts a pure tone in the right bin', () => {
    const n = 1024
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 64 * i) / n)
    fft(re, im)
    let best = 0
    for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[best], im[best])) best = k
    expect(best).toBe(64)
  })

  it('refuses a size that is not a power of two instead of padding quietly', () => {
    expect(() => fft(new Float64Array(1000), new Float64Array(1000))).toThrow(RangeError)
  })
})

describe('hpssFrames', () => {
  it('calls steady tones harmonic', () => {
    const h = hpssFrames(stftMagnitude(tones(3), SR, 2048, 1024))
    const mid = h.harmonic.length >> 1
    expect(mean(h.harmonic, 5, h.harmonic.length - 5)).toBeGreaterThan(0.8)
    expect(h.percussive[mid]).toBeLessThan(0.1)
  })

  it('calls clicks percussive', () => {
    const spec = stftMagnitude(clicks(3, 0.25), SR, 2048, 1024)
    const h = hpssFrames(spec)
    let best = 0
    for (let t = 0; t < h.percussive.length; t++) if (!h.silent[t]) best = Math.max(best, h.percussive[t])
    expect(best).toBeGreaterThan(0.6)
  })

  it('reports silence as silent, not as 100% of something', () => {
    const h = hpssFrames(stftMagnitude(new Float32Array(SR * 2), SR, 2048, 1024))
    expect(h.silent.every(v => v === 1)).toBe(true)
    expect(mean(h.harmonic) + mean(h.percussive) + mean(h.residual)).toBe(0)
  })

  it('fractions of a non-silent frame add up to 1', () => {
    const x = tones(2)
    const c = clicks(2, 0.25)
    for (let i = 0; i < x.length; i++) x[i] += c[i]
    const h = hpssFrames(stftMagnitude(x, SR, 2048, 1024))
    for (let t = 0; t < h.harmonic.length; t++) {
      if (h.silent[t]) continue
      expect(h.harmonic[t] + h.percussive[t] + h.residual[t]).toBeCloseTo(1, 4)
    }
  })
})

describe('stereoCentre', () => {
  const left = tones(2)

  it('reads a centred sound as centre and flags identical channels as mono', () => {
    const spec = stftMagnitude(left, SR)
    const r = stereoCentre(spec, spec)
    expect(mean(r.centre, 2)).toBeGreaterThan(0.99)
    expect(r.mono).toBe(true)
  })

  it('reads a hard-panned sound as not centre, and not mono', () => {
    const r = stereoCentre(stftMagnitude(left, SR), stftMagnitude(new Float32Array(left.length), SR))
    expect(mean(r.centre, 2)).toBeLessThan(0.05)
    expect(r.mono).toBe(false)
  })

  it('reads a real stereo image (different content each side) as not mono', () => {
    const other = clicks(2, 0.25)
    const r = stereoCentre(stftMagnitude(left, SR), stftMagnitude(other, SR))
    expect(r.mono).toBe(false)
  })

  it('throws when the channels differ in length rather than aligning them silently', () => {
    expect(() => stereoCentre(stftMagnitude(tones(2), SR), stftMagnitude(tones(3), SR))).toThrow(RangeError)
  })
})
