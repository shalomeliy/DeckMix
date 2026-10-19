import { describe, expect, it } from 'vitest'
import { KICK_GAP_WARN_MS, kickGap, summarizeGaps } from '@/core/kick-gap'

const SR = 44100
const BEAT = 60 / 128

/** A 55 Hz kick with a fast decay on every beat, the whole thing `shiftSec` later. */
function kicks(shiftSec: number, seconds = 3, amp = 0.8): Float32Array {
  const x = new Float32Array(Math.floor(SR * seconds))
  for (let i = 0; i < x.length; i++) {
    const t = i / SR - shiftSec
    if (t < 0) continue
    const phase = t % BEAT
    x[i] = amp * Math.exp(-phase * 18) * Math.sin(2 * Math.PI * 55 * phase)
  }
  return x
}

const med = (g: number[]) => [...g].sort((a, b) => a - b)[Math.floor(g.length / 2)]

describe('kickGap', () => {
  it('reads two kick trains that sit together as ~0', () => {
    const g = kickGap(kicks(0), kicks(0, 3, 0.4), SR, BEAT * 1000)
    expect(g.length).toBeGreaterThan(3)
    expect(Math.abs(med(g))).toBeLessThan(3)
  })

  it.each([20, -35, 60])('finds a %i ms gap, with its sign (positive = incoming later)', (ms) => {
    const g = kickGap(kicks(0), kicks(ms / 1000), SR, BEAT * 1000)
    expect(g.length).toBeGreaterThan(3)
    expect(med(g)).toBeGreaterThan(ms - 4)
    expect(med(g)).toBeLessThan(ms + 4)
  })

  it('finds nothing when a deck has no kick in the band, and nothing in a steady tone', () => {
    expect(kickGap(kicks(0), new Float32Array(SR * 3), SR, BEAT * 1000)).toEqual([])
    const tone = new Float32Array(SR * 3).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR))
    expect(kickGap(tone, tone, SR, BEAT * 1000)).toEqual([])
  })

  it('does not match kicks more than half a beat apart', () => {
    expect(kickGap(kicks(0), kicks(0.3), SR, 200)).toEqual([])
  })
})

describe('summarizeGaps', () => {
  it('is null when too few pairs matched in the whole mix', () => {
    expect(summarizeGaps([[], [], [3, 4]])).toBeNull()
  })
  it('pools the windows: median signed, p90 of the distances, windows counted', () => {
    const s = summarizeGaps([[4, 6], [], [5], [-30, 5, 4]])!
    expect(s.pairs).toBe(6)
    expect(s.read).toBe(4)
    expect(s.measured).toBe(3)
    expect(s.medianMs).toBe(5)
    expect(s.p90Ms).toBe(30)
  })
  it('has a warning threshold in the ms range of a flam, not of a groove', () => {
    expect(KICK_GAP_WARN_MS).toBeGreaterThan(5)
    expect(KICK_GAP_WARN_MS).toBeLessThan(30)
  })
})
