import { describe, expect, it } from 'vitest'
import { keyLockSemitones } from '@/core/key-lock'

describe('keyLockSemitones (v0.9.20)', () => {
  it('undoes exactly what the rate did to the pitch', () => {
    expect(keyLockSemitones(1)).toBe(-0)
    expect(keyLockSemitones(2)).toBeCloseTo(-12)
    expect(keyLockSemitones(0.5)).toBeCloseTo(12)
    // +8% on the tempo fader is 1.33 semitones up; the stretch takes it back down.
    expect(keyLockSemitones(1.08)).toBeCloseTo(-1.3324, 4)
    expect(440 * 1.08 * 2 ** (keyLockSemitones(1.08) / 12)).toBeCloseTo(440, 9)
  })
  it('a stopped or reversed deck is not transposed (a scratch is never keyed anyway)', () => {
    expect(keyLockSemitones(0)).toBe(0)
    expect(keyLockSemitones(-1)).toBe(0)
    expect(keyLockSemitones(Number.NaN)).toBe(0)
  })
})
