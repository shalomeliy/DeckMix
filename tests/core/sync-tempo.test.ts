import { describe, expect, it } from 'vitest'
import { halfDoubleMultiplier, syncMultiplier, syncTempoFor, tempoToRate } from '@/core/constants'
import { phaseDeltaSec } from '@/core/beatgrid'

const RANGE = 0.08

describe('syncTempoFor', () => {
  it('matches the master exactly when its fader is at zero', () => {
    const t = syncTempoFor(125, 0, 119, RANGE)
    expect(119 * tempoToRate(t, RANGE)).toBeCloseTo(125, 6)
  })

  it('follows the master AUDIBLE bpm, not its native bpm, when the master is tempo-shifted', () => {
    // The reported bug: master native 125 at -4.8% plays at ~119; the old code
    // synced to 125 and left the decks 6 BPM apart.
    const masterTempo = -0.048 / RANGE
    const t = syncTempoFor(125, masterTempo, 119, RANGE)
    const masterAudible = 125 * tempoToRate(masterTempo, RANGE)
    expect(119 * tempoToRate(t, RANGE)).toBeCloseTo(masterAudible, 6)
    expect(masterAudible).toBeCloseTo(119, 1)
  })
})

// v0.8.36: Mix Assist offers an 85 under a 170 ("half-time"); SYNC used to ask
// the 85 for +100% and the ±8% fader clamped it at 91.8 — never locked.
describe('half/double time', () => {
  it('an 85 under a 170 syncs at half-time: a small fader move, not +100%', () => {
    const t = syncTempoFor(170, 0, 85, RANGE)
    expect(t).toBeCloseTo(0, 6)
    expect(halfDoubleMultiplier(170, 85)).toBe(2)
  })
  it('a 172 under an 86 syncs double-time and lands on 2× the master', () => {
    const t = syncTempoFor(86, 0, 172, RANGE)
    expect(Math.abs(t)).toBeLessThan(1)
    expect(172 * tempoToRate(t, RANGE)).toBeCloseTo(172, 6)
    expect(halfDoubleMultiplier(86, 172)).toBe(0.5)
  })
  it('a near-straight pair stays straight', () => {
    expect(halfDoubleMultiplier(128, 124)).toBe(1)
    expect(halfDoubleMultiplier(100, 130)).toBe(1)
  })
})

describe('phase lock at half-time', () => {
  it("an 85's beat midway between its own beats is ON the 170's beat once read at the master's rate", () => {
    const master = { bpm: 170, offsetSec: 0 }
    const deck = { bpm: 85, offsetSec: 0 }
    const deckAt = 0.5 * (60 / 85) // halfway through the 85's beat = exactly one 170 beat
    const masterAt = 60 / 170
    expect(Math.abs(phaseDeltaSec(deckAt, deck, masterAt, master))).toBeGreaterThan(0.1) // the old reading: half a beat off
    expect(phaseDeltaSec(deckAt, { ...deck, bpm: 85 * halfDoubleMultiplier(170, 85) }, masterAt, master)).toBeCloseTo(0, 9)
  })
})

// v0.8.36 review: at wide tempo ranges the choice must not flip pairs that
// already synced straight, nor depend on which deck is master.
describe('syncMultiplier keeps reachable pairs straight', () => {
  it('±50%: a 140 under a 100 stays straight (was going to jump to double-time)', () => {
    expect(syncMultiplier(100, 140, 0.5)).toBe(1)
    expect(syncMultiplier(140, 100, 0.5)).toBe(1)
    expect(140 * tempoToRate(syncTempoFor(100, 0, 140, 0.5), 0.5)).toBeCloseTo(100, 6)
  })
  it('±8%: an 85 under a 170 is out of straight reach, so half-time', () => {
    expect(syncMultiplier(170, 85, RANGE)).toBe(2)
  })
  it('the playing ratio of a synced pair always reads back the same multiplier', () => {
    // the loop re-derives it from playing BPMs: 100@+10% (=110) with a 140 synced straight
    const t = syncTempoFor(100, 0.1 / 0.5, 140, 0.5)
    expect(halfDoubleMultiplier(110, 140 * tempoToRate(t, 0.5))).toBe(1)
  })
})
