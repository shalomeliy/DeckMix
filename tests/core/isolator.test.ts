import { describe, expect, it } from 'vitest'
import { EQ_CUT_DB, EQ_DB } from '@/core/constants'
import { ISOLATOR_PATHS, ISO_LOW_MID_HZ, ISO_MID_HIGH_HZ, bandGain, isolatorResponseDb } from '@/core/isolator'

const SR = 48000
const FREQS = [20, 40, 60, 100, 150, 200, 250, 300, 500, 1000, 2000, 3000, 4000, 6000, 8000, 12000, 16000]
const FLAT = { low: 1, mid: 1, high: 1 }

describe('isolator — three bands that add back up to the song (v0.9.33)', () => {
  it('with every knob in the middle the song comes out unchanged in level, at every frequency', () => {
    for (const sr of [44100, 48000]) for (const f of FREQS) expect(Math.abs(isolatorResponseDb(f, sr, FLAT))).toBeLessThan(0.05)
  })

  it('a lowpass/highpass Q is written in dB, as the Web Audio spec reads it — a Butterworth is −3.01 dB there, 0.707 on the allpass', () => {
    for (const path of Object.values(ISOLATOR_PATHS))
      for (const f of path) expect(f.q).toBeCloseTo(f.type === 'allpass' ? Math.SQRT1_2 : -3.0103, 3)
  })

  // The bug this replaced (07/10): the old MID kill (a peaking filter, −70 dB, Q 0.9) took −16 dB off 100 Hz and −17 dB off 8 kHz, and
  // the old LOW kill (a 100 Hz shelf) −16 dB off 300 Hz. A kill now removes its own band and leaves the others.
  it('killing MID leaves the bass and the hats', () => {
    const g = { low: 1, mid: 0, high: 1 }
    for (const f of [20, 40, 60, 100]) expect(isolatorResponseDb(f, SR, g)).toBeGreaterThan(-0.5)
    for (const f of [8000, 12000, 16000]) expect(isolatorResponseDb(f, SR, g)).toBeGreaterThan(-0.5)
    expect(isolatorResponseDb(1000, SR, g)).toBeLessThan(-30)
  })

  it('killing LOW removes the bass and kick and leaves the voice', () => {
    const g = { low: 0, mid: 1, high: 1 }
    for (const f of [40, 60]) expect(isolatorResponseDb(f, SR, g)).toBeLessThan(-40)
    expect(isolatorResponseDb(100, SR, g)).toBeLessThan(-24)
    for (const f of [500, 1000, 4000]) expect(isolatorResponseDb(f, SR, g)).toBeGreaterThan(-0.6)
  })

  it('A on its bass alone and B without its bass add up to one whole song', () => {
    for (const f of FREQS) {
      // Different songs add as power: |A's part|² + |B's part|².
      const a = 10 ** (isolatorResponseDb(f, SR, { low: 1, mid: 0, high: 0 }) / 10)
      const b = 10 ** (isolatorResponseDb(f, SR, { low: 0, mid: 1, high: 1 }) / 10)
      // −3 dB at the crossover itself, where each band is at −6 dB: the price of any crossover, within an octave of it.
      const nearCrossover = f >= ISO_LOW_MID_HZ / 2 && f <= ISO_LOW_MID_HZ * 2
      expect(10 * Math.log10(a + b)).toBeGreaterThan(nearCrossover ? -3.1 : -1)
    }
  })

  it('the crossovers sit where the bands are named: bass and kick under them, voice between, hats over', () => {
    expect(ISO_LOW_MID_HZ).toBeGreaterThanOrEqual(150)
    expect(ISO_LOW_MID_HZ).toBeLessThanOrEqual(400)
    expect(ISO_MID_HIGH_HZ).toBeGreaterThanOrEqual(2000)
    expect(ISO_MID_HIGH_HZ).toBeLessThanOrEqual(5000)
  })

  it('a knob keeps its old dB scale: −1 is −70 dB, +1 is the eqDb setting, 0 is unity', () => {
    expect(bandGain(0, EQ_DB, EQ_CUT_DB)).toBe(1)
    expect(20 * Math.log10(bandGain(-1, EQ_DB, EQ_CUT_DB))).toBeCloseTo(-70, 6)
    expect(20 * Math.log10(bandGain(1, EQ_DB, EQ_CUT_DB))).toBeCloseTo(EQ_DB, 6)
  })
})
