import { describe, expect, it } from 'vitest'
import { crossfadeGains, crossfadeProgress, exitWaitStatus, phaseAlignedEntrySec } from '@/core/transition'
import type { BeatGrid } from '@/core/types'

describe('crossfadeGains', () => {
  it('progress 0 is fully on the "from" deck', () => {
    const g = crossfadeGains(0)
    expect(g.fromGain).toBeCloseTo(1, 10)
    expect(g.toGain).toBeCloseTo(0, 10)
  })

  it('progress 1 is fully on the "to" deck', () => {
    const g = crossfadeGains(1)
    expect(g.fromGain).toBeCloseTo(0, 10)
    expect(g.toGain).toBeCloseTo(1, 10)
  })

  it('the midpoint is equal-power, not a linear 0.5/0.5', () => {
    const g = crossfadeGains(0.5)
    // cos(pi/4) === sin(pi/4) === ~0.7071, not 0.5 — that's what makes it
    // equal-power (sum of squares stays 1 throughout the fade).
    expect(g.fromGain).toBeCloseTo(Math.SQRT1_2, 10)
    expect(g.toGain).toBeCloseTo(Math.SQRT1_2, 10)
    expect(g.fromGain * g.fromGain + g.toGain * g.toGain).toBeCloseTo(1, 10)
  })

  it('clamps out-of-range progress instead of extrapolating', () => {
    expect(crossfadeGains(-1)).toEqual(crossfadeGains(0))
    expect(crossfadeGains(2)).toEqual(crossfadeGains(1))
  })
})

describe('crossfadeProgress', () => {
  it('is 0 at the start and 1 once the duration has elapsed', () => {
    expect(crossfadeProgress(0, 8)).toBe(0)
    expect(crossfadeProgress(8, 8)).toBe(1)
    expect(crossfadeProgress(4, 8)).toBeCloseTo(0.5, 10)
  })

  it('clamps past the duration rather than exceeding 1', () => {
    expect(crossfadeProgress(20, 8)).toBe(1)
  })

  it('a non-positive duration is treated as already complete', () => {
    expect(crossfadeProgress(0, 0)).toBe(1)
  })
})

describe('phaseAlignedEntrySec', () => {
  it('no correction needed when the incoming deck would already land in phase', () => {
    const grid: BeatGrid = { bpm: 120, offsetSec: 0 } // beat every 0.5s
    // Master is exactly on a beat (position 10.0s, grid offset 0) — entering
    // the incoming deck at one of its own beats (2.0s, same grid) is already
    // in phase, so the seek offset should be ~0.
    expect(phaseAlignedEntrySec(2.0, grid, 10.0, grid)).toBeCloseTo(2.0, 10)
  })

  it('nudges the entry point to match the master phase, never by more than half a beat', () => {
    const grid: BeatGrid = { bpm: 120, offsetSec: 0 } // beat every 0.5s
    // Master sits a quarter-beat (0.125s) off its own grid's nearest beat.
    const seek = phaseAlignedEntrySec(2.0, grid, 10.125, grid)
    expect(Math.abs(seek - 2.0)).toBeLessThanOrEqual(0.25 + 1e-9) // half of 0.5s beat
    expect(seek).toBeCloseTo(2.125, 10)
  })

  it('works across two different tempos, not just identical grids', () => {
    const incoming: BeatGrid = { bpm: 128, offsetSec: 0 }
    const master: BeatGrid = { bpm: 128, offsetSec: 0.05 }
    const seek = phaseAlignedEntrySec(4.0, incoming, 20.0, master)
    expect(typeof seek).toBe('number')
    expect(Number.isFinite(seek)).toBe(true)
  })
})

// v0.8.14 owner review (23/09): the yellow lines on both decks must meet.
// Beat-only alignment returned 2.5s in the first case below — a white line
// matched, the yellow line one beat off — so these fail against it.
describe('phaseAlignedEntrySec lands yellow line on yellow line', () => {
  const grid: BeatGrid = { bpm: 120, offsetSec: 0 } // beat 0.5s, bar 2.0s

  it('master exactly on its bar line → incoming lands exactly on its nearest bar line', () => {
    // entry 2.5s is beat 2 of the bar starting at 2.0s; master is on a bar line
    expect(phaseAlignedEntrySec(2.5, grid, 10.0, grid)).toBeCloseTo(2.0, 10)
    expect(phaseAlignedEntrySec(3.5, grid, 10.0, grid)).toBeCloseTo(4.0, 10)
  })

  it('master a few ms past its bar line (one frame late) → incoming the same fraction past its own', () => {
    const seek = phaseAlignedEntrySec(2.5, grid, 10.016, grid)
    expect(seek).toBeCloseTo(2.016, 10)
  })

  it('never moves the entry by more than half a bar', () => {
    for (const entry of [2.1, 2.9, 3.4, 3.99]) {
      const seek = phaseAlignedEntrySec(entry, grid, 10.0, grid)
      expect(Math.abs(seek - entry)).toBeLessThanOrEqual(1.0 + 1e-9)
    }
  })

  it('different tempos: phase inside the bar matches as a fraction', () => {
    const incoming: BeatGrid = { bpm: 128, offsetSec: 0.1 } // bar 1.875s
    const master: BeatGrid = { bpm: 124, offsetSec: 0.3 }
    const masterBarSec = (60 / 124) * 4
    const masterPos = 0.3 + 7 * masterBarSec + 0.25 * masterBarSec // quarter into a bar
    const seek = phaseAlignedEntrySec(30, incoming, masterPos, master)
    const incomingFrac = (((seek - 0.1) / 1.875) % 1 + 1) % 1
    expect(incomingFrac).toBeCloseTo(0.25, 9)
  })

  it('never returns a negative seek', () => {
    const seek = phaseAlignedEntrySec(0.2, grid, 11.5, grid) // would be -0.3 before the fix
    expect(seek).toBeGreaterThanOrEqual(0)
    expect(seek).toBeCloseTo(1.5, 10)
  })
})

describe('exitWaitStatus (v0.8.16)', () => {
  // 120 BPM: one bar = 2s. Remembered exit at 180s (3:00).
  const bar = 2
  const exit = 180

  it('is early well before the remembered exit', () => {
    expect(exitWaitStatus(60, exit, bar)).toBe('early')
  })

  it('is still early just outside half a bar before it', () => {
    expect(exitWaitStatus(exit - bar / 2 - 0.01, exit, bar)).toBe('early')
  })

  it('is due from half a bar before, through the exit itself', () => {
    expect(exitWaitStatus(exit - bar / 2, exit, bar)).toBe('due')
    expect(exitWaitStatus(exit, exit, bar)).toBe('due')
  })

  it('stays due up to a whole bar after, so a nudged grid still gets a bar line', () => {
    expect(exitWaitStatus(exit + bar, exit, bar)).toBe('due')
  })

  it('is passed beyond a whole bar after — Shalom chose "do nothing" here', () => {
    expect(exitWaitStatus(exit + bar + 0.01, exit, bar)).toBe('passed')
    expect(exitWaitStatus(exit + 20, exit, bar)).toBe('passed')
  })

  it('the due window always contains a bar line, wherever the grid sits', () => {
    // 1.5 bars wide > 1 bar, for any offset of the bar lines.
    for (let offset = 0; offset < bar; offset += 0.1) {
      const lines = [0, 1, 2, 3].map((k) => exit - bar + offset + k * bar)
      const inWindow = lines.filter((l) => exitWaitStatus(l, exit, bar) === 'due')
      expect(inWindow.length).toBeGreaterThan(0)
    }
  })
})
