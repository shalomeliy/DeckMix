import { describe, expect, it } from 'vitest'
import { beatFractionToSeconds, BIT_CRUSH_BITS, crossfaderGains, crushSample, equalPowerMix, FX_EFFECTS, FX_TIME_STEPS } from '@/core/fx'

describe('beatFractionToSeconds', () => {
  // 128 BPM => 60/128 = 0.46875 sec/beat, exact values a wrong formula would miss.
  it.each([
    [0.25, 0.1171875],
    [0.5, 0.234375],
    [1, 0.46875],
    [2, 0.9375],
    [4, 1.875],
  ])('at 128 BPM, %s beats is %s seconds', (fraction, expected) => {
    expect(beatFractionToSeconds(128, fraction)).toBeCloseTo(expected, 6)
  })

  it('falls back to a fixed, audibly-wrong-not-silent value when BPM is unknown', () => {
    expect(beatFractionToSeconds(null, 0.25)).toBe(0.5)
    expect(beatFractionToSeconds(0, 1)).toBe(0.5)
    expect(beatFractionToSeconds(-10, 1)).toBe(0.5)
  })

  it('never returns NaN, Infinity or a negative value', () => {
    for (const bpm of [null, 0, -5, 1, 999]) {
      for (const f of FX_TIME_STEPS) {
        const v = beatFractionToSeconds(bpm, f)
        expect(Number.isFinite(v)).toBe(true)
        expect(v).toBeGreaterThan(0)
      }
    }
  })
})

describe('equalPowerMix', () => {
  it('is fully dry at t=0', () => {
    const { dry, wet } = equalPowerMix(0)
    expect(dry).toBeCloseTo(1, 6)
    expect(wet).toBeCloseTo(0, 6)
  })

  it('is fully wet at t=1', () => {
    const { dry, wet } = equalPowerMix(1)
    expect(dry).toBeCloseTo(0, 6)
    expect(wet).toBeCloseTo(1, 6)
  })

  it('is equal-power (not linear) at the midpoint', () => {
    const { dry, wet } = equalPowerMix(0.5)
    expect(dry).toBeCloseTo(Math.SQRT1_2, 6)
    expect(wet).toBeCloseTo(Math.SQRT1_2, 6)
  })

  it('clamps out-of-range input instead of producing a negative or >1 gain', () => {
    expect(equalPowerMix(-1)).toEqual(equalPowerMix(0))
    expect(equalPowerMix(2)).toEqual(equalPowerMix(1))
  })

  /**
   * Regression guard, not a new-feature test: this is the exact curve
   * `engine.ts`'s `setCrossfader` already used before it was factored out
   * to call this function. `setCrossfader(x)` maps x in [-1,1] to t=(x+1)/2
   * and used `a=cos(t*pi/2)`/`b=cos((1-t)*pi/2)` for deck A/B gain — those
   * are exactly `dry`/`wet` here. If this ever stops matching, the
   * crossfader's feel has silently changed.
   */
  it('reproduces the pre-extraction crossfader curve at A-only, center, and B-only', () => {
    const crossfaderGains = (x: number) => {
      const t = (x + 1) / 2
      return { a: Math.cos((t * Math.PI) / 2), b: Math.cos(((1 - t) * Math.PI) / 2) }
    }
    for (const x of [-1, -0.5, 0, 0.5, 1]) {
      const t = (x + 1) / 2
      const { dry, wet } = equalPowerMix(t)
      const { a, b } = crossfaderGains(x)
      expect(dry).toBeCloseTo(a, 6)
      expect(wet).toBeCloseTo(b, 6)
    }
  })
})

describe('FX_EFFECTS / FX_TIME_STEPS', () => {
  it('lists all 8 roadmap effects, in ROADMAP.md order, worklet effects appended at the end', () => {
    expect(FX_EFFECTS).toEqual([
      'delay',
      'echo',
      'reverb',
      'filter',
      'bitcrusher',
      'roll',
      'flanger',
      'phaser',
    ])
  })

  it('covers the roadmap\'s 1/4..4 beat range', () => {
    expect(FX_TIME_STEPS).toEqual([0.25, 0.5, 1, 2, 4])
  })
})

describe('crushSample', () => {
  it.each([
    [0, 16, 0],
    [0.9, 1, 1],
    [-0.9, 1, -1],
    [0.05, 1, 0],
  ])('quantizes %s at %s bits to %s', (sample, bits, expected) => {
    expect(crushSample(sample, bits)).toBeCloseTo(expected, 6)
  })

  it('never returns a value outside -1..1 for in-range input', () => {
    for (const sample of [-1, -0.5, -0.001, 0, 0.001, 0.5, 1]) {
      for (const bits of [1, 2, 4, 8, 16]) {
        const v = crushSample(sample, bits)
        expect(v).toBeGreaterThanOrEqual(-1 - Number.EPSILON)
        expect(v).toBeLessThanOrEqual(1 + Number.EPSILON)
      }
    }
  })

  it('higher bit depth is monotonically closer to the original sample (finer steps)', () => {
    const sample = 0.37
    const err = (bits: number) => Math.abs(crushSample(sample, bits) - sample)
    expect(err(8)).toBeLessThanOrEqual(err(4))
    expect(err(16)).toBeLessThanOrEqual(err(8))
  })

  it('BIT_CRUSH_BITS is a small, fixed, musically-crushed depth', () => {
    expect(BIT_CRUSH_BITS).toBe(4)
  })
})

describe('crossfaderGains', () => {
  it("'power' is equalPowerMix — the owner's hand never hears a different crossfader", () => {
    for (const t of [0, 0.2, 0.5, 0.9, 1]) {
      const { dry, wet } = equalPowerMix(t)
      expect(crossfaderGains(t)).toEqual({ a: dry, b: wet })
    }
  })
  it("'full-middle' has both decks at full in the middle, and each side alone at its end", () => {
    expect(crossfaderGains(0.5, 'full-middle')).toEqual({ a: 1, b: 1 })
    expect(crossfaderGains(0, 'full-middle')).toEqual({ a: 1, b: 0 })
    const end = crossfaderGains(1, 'full-middle')
    expect(end.a).toBeCloseTo(0)
    expect(end.b).toBe(1)
    // On the way in, still a power curve: a quarter of the way is −3 dB, not a straight line's −6.
    expect(crossfaderGains(0.25, 'full-middle').b).toBeCloseTo(Math.SQRT1_2)
  })
})
