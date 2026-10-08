import { describe, expect, it } from 'vitest'
import { relativeDelta } from '@/core/mapping/mapping'

/**
 * The bug these pin down was invisible in code and only appeared against the
 * hardware. `midi-check.html` on the user's DDJ-FLX4 recorded 38, 55 and 75 jog
 * messages decoding to 2394, 3465 and 4725 ticks — exactly 63 per message, every
 * message, on every wheel. A slow turn cannot produce the maximum magnitude every
 * time, so the raw bytes had to be 63 and 65: one either side of 64. The preset
 * was reading them as two's-complement, which is +63 and -63 — every tick
 * amplified 63x and pointed the wrong way.
 *
 * Both schemes are kept and both are tested, because the choice is a property of
 * the controller and the next one may well differ.
 */
describe('relativeDelta', () => {
  it("defaults to two's-complement, the documented convention", () => {
    expect(relativeDelta(1)).toBe(1)
    expect(relativeDelta(63)).toBe(63)
    expect(relativeDelta(127)).toBe(-1)
    expect(relativeDelta(65)).toBe(-63)
    expect(relativeDelta(0)).toBe(0)
  })

  it('reads offset-64 as one tick either side of centre', () => {
    expect(relativeDelta(64, 'offset-64')).toBe(0)
    expect(relativeDelta(65, 'offset-64')).toBe(1)
    expect(relativeDelta(63, 'offset-64')).toBe(-1)
  })

  it('scales with the speed of the turn rather than saturating', () => {
    // The point of the fix: a fast spin is a larger byte, not a larger count of
    // saturated messages. 70 is six ticks, not another 63.
    expect(relativeDelta(70, 'offset-64')).toBe(6)
    expect(relativeDelta(58, 'offset-64')).toBe(-6)
  })

  it('is the measured FLX4 case: 63 and 65 are one tick, not 63', () => {
    // Precisely what was wrong. Left as its own case so the regression reads as
    // the hardware finding it is, not as arithmetic.
    expect(Math.abs(relativeDelta(63, 'offset-64'))).toBe(1)
    expect(Math.abs(relativeDelta(65, 'offset-64'))).toBe(1)
    expect(Math.abs(relativeDelta(63))).toBe(63) // the old reading, kept visible
  })

  it('never returns a magnitude past 64 for any legal byte', () => {
    for (let v = 0; v <= 127; v++) {
      expect(Math.abs(relativeDelta(v, 'offset-64'))).toBeLessThanOrEqual(64)
      expect(Math.abs(relativeDelta(v))).toBeLessThanOrEqual(64)
    }
  })
})

import { browseDelta } from '@/core/mapping/mapping'

describe('browse wheel (08/10, owner measured `cc ch7 #64 = 1`)', () => {
  it('is two\'s complement: 1 is one row down, 127 one row up', () => {
    expect(browseDelta(1)).toBe(1)
    expect(browseDelta(2)).toBe(2)
    expect(browseDelta(127)).toBe(-1)
    expect(browseDelta(126)).toBe(-2)
  })

  it('never jumps a whole screen for one tick (the offset-64 reading gave -63 / +63)', () => {
    for (const v of [1, 127]) expect(Math.abs(browseDelta(v))).toBe(1)
  })
})
