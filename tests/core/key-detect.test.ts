import { describe, expect, it } from 'vitest'
import { FFT_SIZE, KK_MAJOR, LIBRARY_MINOR, camelotOf, detectKey, fft, keyFromChroma } from '@/core/key-detect.ts'

const RATE = 44100
/** Sine tones at the given MIDI notes, summed, `sec` long. */
function tones(midi: number[], sec = 6): Float32Array {
  const out = new Float32Array(Math.round(sec * RATE))
  for (const m of midi) {
    const f = 440 * 2 ** ((m - 69) / 12)
    for (let i = 0; i < out.length; i++) out[i] += 0.2 * Math.sin((2 * Math.PI * f * i) / RATE)
  }
  return out
}

describe('fft', () => {
  it('puts a pure bin-aligned tone in its bin', () => {
    const n = 64
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n)
    fft(re, im)
    const mags = Array.from(re, (r, i) => Math.hypot(r, im[i]))
    expect(mags[5]).toBeCloseTo(n / 2, 6)
    expect(mags[10]).toBeCloseTo(0, 6)
  })
})

describe('keyFromChroma', () => {
  it('a chroma shaped like a profile comes back as that key, at any tonic', () => {
    for (let tonic = 0; tonic < 12; tonic++) {
      const maj = Array.from({ length: 12 }, (_, i) => KK_MAJOR[(i - tonic + 12) % 12])
      const min = Array.from({ length: 12 }, (_, i) => LIBRARY_MINOR[(i - tonic + 12) % 12])
      expect(keyFromChroma(maj)).toMatchObject({ tonic, minor: false })
      expect(keyFromChroma(min)).toMatchObject({ tonic, minor: true })
    }
  })

  it('a flat chroma is no key, not a guess', () => {
    expect(keyFromChroma(new Array(12).fill(1))).toBeNull()
  })
})

describe('detectKey on synthetic audio', () => {
  it('A minor tones → 8A', () => {
    const k = detectKey([tones([45, 57, 60, 64, 69, 71, 62])], RATE)
    expect(k && camelotOf(k)).toBe('8A')
  })

  it('C major tones → 8B', () => {
    const k = detectKey([tones([48, 60, 64, 67, 55, 72, 65, 62])], RATE)
    expect(k && camelotOf(k)).toBe('8B')
  })

  it('too short or silent says nothing', () => {
    expect(detectKey([new Float32Array(FFT_SIZE - 1)], RATE)).toBeNull()
    expect(detectKey([new Float32Array(RATE * 5)], RATE)).toBeNull()
  })
})

describe('camelotOf', () => {
  it('uses the same wheel as the tags', () => {
    expect(camelotOf({ tonic: 9, minor: true })).toBe('8A')
    expect(camelotOf({ tonic: 0, minor: false })).toBe('8B')
    expect(camelotOf({ tonic: 4, minor: true })).toBe('9A')
    expect(camelotOf({ tonic: 7, minor: false })).toBe('9B')
  })
})
