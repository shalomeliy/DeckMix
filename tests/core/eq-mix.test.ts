import { describe, expect, it } from 'vitest'
import { EQ_CUT_DB, EQ_DB } from '@/core/constants'
import { crossfaderGains, type CrossfaderCurve } from '@/core/fx'
import { AUTO_MIX_CROSSFADER_CURVE, EQ_KILL, MIX_MID_CUT, eqMixFrame, incomingUnderA, plainEqMixPlan, type BassSwapStyle, type EqBands } from '@/core/eq-mix'

const flat: EqBands = { low: 0, mid: 0, high: 0 }
const own = { a: flat, b: flat }
// 120 BPM: a bar is 2 s. Join at 44, the swap (the handoff) 8 bars later at 60, A out 8 bars after that at 76.
const plan = { joinSec: 44, swapSec: 60, fadeEndSec: 76 }
const BAR = 2
const frame = (pos: number, style: BassSwapStyle = 'instant', o = own) => eqMixFrame(plan, pos, BAR, o, style)
const amp = (knob: number) => 10 ** ((knob * EQ_CUT_DB) / 20)
const sweep = (fn: (pos: number) => void) => {
  for (let pos = 40; pos <= 80; pos += 0.01) fn(pos)
}

describe('eqMixFrame — never two basses at once (v0.9.18)', () => {
  it('instant: B comes in with its LOW killed, and the two lows swap exactly on the swap line', () => {
    expect(frame(44).b.low).toBe(EQ_KILL)
    expect(frame(59.99).a.low).toBe(0)
    expect(frame(59.99).b.low).toBe(EQ_KILL)
    expect(frame(60).a.low).toBe(EQ_KILL)
    expect(frame(60).b.low).toBe(0)
  })
  it('instant: at no moment of the whole transition are both lows open', () => {
    sweep((pos) => {
      const f = frame(pos)
      expect(f.a.low === EQ_KILL || f.b.low === EQ_KILL).toBe(true)
    })
  })
  it('gradual: the two basses together never pass the power of one, and only inside the bar after the swap', () => {
    sweep((pos) => {
      const f = frame(pos, 'gradual')
      // 1e-6: a killed knob is −70 dB, not silence — 1e-7 of power is left in it.
      expect(amp(f.a.low) ** 2 + amp(f.b.low) ** 2).toBeLessThanOrEqual(1 + 1e-6)
      if (pos < 60 || pos >= 62) expect(f.a.low === EQ_KILL || f.b.low === EQ_KILL).toBe(true)
    })
  })
  it('gradual: halfway through the bar both are at half power (−3 dB), not the −35 dB a straight knob line would give', () => {
    const half = frame(61, 'gradual')
    expect(amp(half.a.low)).toBeCloseTo(Math.SQRT1_2, 3)
    expect(amp(half.b.low)).toBeCloseTo(Math.SQRT1_2, 3)
    expect(frame(62, 'gradual').a.low).toBe(EQ_KILL)
    expect(frame(62, 'gradual').b.low).toBe(0)
  })
})

describe('eqMixFrame — gradual swap with a boosted LOW (independent review, 05/10)', () => {
  // The boost side is scaled by the owner's eqDb (26 dB by default), the cut side by EQ_CUT_DB: the curve has to count both in real dB.
  const dbOf = (k: number) => (k >= 0 ? k * 26 : k * EQ_CUT_DB)
  const boosted = { a: { low: 0.5, mid: 0, high: 0 }, b: { low: 0.5, mid: 0, high: 0 } }
  it('halfway each side is 3 dB under its own +13 dB, and the two together never pass the power of one', () => {
    const half = eqMixFrame(plan, 61, BAR, boosted, 'gradual', 26)
    expect(dbOf(half.a.low)).toBeCloseTo(13 - 3.01, 1)
    expect(dbOf(half.b.low)).toBeCloseTo(13 - 3.01, 1)
    for (let pos = 60; pos <= 62; pos += 0.01) {
      const f = eqMixFrame(plan, pos, BAR, boosted, 'gradual', 26)
      const p = 10 ** (dbOf(f.a.low) / 10) + 10 ** (dbOf(f.b.low) / 10)
      expect(p).toBeLessThanOrEqual(10 ** (13 / 10) * (1 + 1e-6))
    }
    expect(eqMixFrame(plan, 62, BAR, boosted, 'gradual', 26).b.low).toBe(0.5)
  })
})

describe('eqMixFrame — MID and HIGH', () => {
  it("B's MID is down while it plays under A; the MIDs swap over the bar after the swap, by power", () => {
    expect(frame(50).b.mid).toBe(MIX_MID_CUT)
    expect(frame(50).a.mid).toBe(0)
    // Halfway, each at half its band's power (−3 dB), not at the knob's midpoint (−14 dB each, until v0.9.33: a 1.3 dB hole in the room).
    const halfPowerDb = 10 * Math.log10((1 + 10 ** ((MIX_MID_CUT * EQ_CUT_DB) / 10)) / 2)
    expect(frame(61).a.mid * EQ_CUT_DB).toBeCloseTo(halfPowerDb, 3)
    expect(frame(61).b.mid * EQ_CUT_DB).toBeCloseTo(halfPowerDb, 3)
    expect(frame(62).a.mid).toBeCloseTo(MIX_MID_CUT)
    expect(frame(62).b.mid).toBeCloseTo(0)
  })
  it("A's HIGH stays until the MID swap is done, and is gone by the time the crossfader starts taking A out", () => {
    expect(frame(62).a.high).toBe(0)
    expect(frame(65).a.high).toBeCloseTo(EQ_KILL / 2)
    expect(frame(68).a.high).toBe(EQ_KILL)
    sweep((pos) => expect(frame(pos).b.high).toBe(0))
  })
  it("never turns up a knob the owner had lower than the cut, and ends B on the owner's own knobs", () => {
    const low = { a: { low: -0.9, mid: -0.8, high: -0.7 }, b: { low: -0.6, mid: -0.9, high: 0.3 } }
    sweep((pos) => {
      const f = frame(pos, 'instant', low)
      expect(f.a.mid).toBeLessThanOrEqual(-0.8)
      expect(f.b.mid).toBeLessThanOrEqual(-0.9)
      expect(f.a.high).toBeLessThanOrEqual(-0.7)
    })
    expect(frame(76, 'instant', low).b).toEqual(low.b)
    expect(frame(76, 'gradual', low).b).toEqual(low.b)
  })
})

describe('eqMixFrame — the crossfader is the volume', () => {
  it('B to the middle over two bars, both in until halfway from the swap to the end, then A out', () => {
    expect(frame(44).progress).toBe(0)
    expect(frame(46).progress).toBeCloseTo(0.25)
    expect(frame(48).progress).toBeCloseTo(0.5)
    expect(frame(60).progress).toBeCloseTo(0.5)
    expect(frame(68).progress).toBeCloseTo(0.5)
    expect(frame(72).progress).toBeCloseTo(0.75)
    expect(frame(76).progress).toBe(1)
  })
  it('a short runway rises in half of it', () => {
    expect(eqMixFrame({ joinSec: 0, swapSec: 2, fadeEndSec: 6 }, 1, 2, own, 'instant').progress).toBeCloseTo(0.5)
  })
})

describe('incomingUnderA', () => {
  it('LOW killed, MID cut, HIGH left alone', () => {
    expect(incomingUnderA({ low: 0.2, mid: 0.1, high: 0.3 })).toEqual({ low: EQ_KILL, mid: MIX_MID_CUT, high: 0.3 })
  })
})

describe('plainEqMixPlan — the same order inside the old 8 seconds', () => {
  it('swaps on the last bar line at or before the middle', () => {
    expect(plainEqMixPlan(8, 1.875)).toEqual({ joinSec: 0, swapSec: 3.75, fadeEndSec: 8 }) // 128 BPM
    expect(plainEqMixPlan(8, 2.4).swapSec).toBeCloseTo(2.4) // 100 BPM
    expect(plainEqMixPlan(8, 2).swapSec).toBeCloseTo(4) // 120 BPM: the middle is a bar line
  })
  it('at least one bar in; a bar longer than the fade falls back to the middle', () => {
    expect(plainEqMixPlan(8, 5).swapSec).toBe(5)
    expect(plainEqMixPlan(8, 10).swapSec).toBe(4)
  })
  it('a plain transition at 128 BPM: lows swap on the line, A has no HIGH left before it leaves, B is whole at the end', () => {
    const p = plainEqMixPlan(8, 1.875)
    for (let t = 0; t <= 8; t += 0.005) {
      const f = eqMixFrame(p, t, 1.875, own, 'instant')
      expect(f.a.low === EQ_KILL || f.b.low === EQ_KILL).toBe(true)
      if (f.progress > 0.5) expect(f.a.high).toBe(EQ_KILL)
    }
    expect(eqMixFrame(p, 8, 1.875, own, 'instant')).toEqual({ progress: 1, a: { low: EQ_KILL, mid: MIX_MID_CUT, high: EQ_KILL }, b: flat })
  })
})

// The owner, 07/10: "during the mix I hear the volume drop, and it must not — the music has to stay at the same level the whole mix". The
// same room model as the vocal swap's test: a dance track's power split bass .4 / mids .45 / highs .15, each band by its knob (exact since
// the isolator, v0.9.33: a knob is the volume of its whole band), each deck by its crossfader gain squared, the decks adding as power. One
// whole song is 0 dB. On the hand crossfader's curve the mix sat at −2.4 to −3 dB from the rise to the fade (B's highs under a −3 dB A, then
// a −3 dB B) and jumped back up at the end; measured on his songs the same drop was 2–2.6 dB on average (`measure-mix-loudness.mjs`).
describe("eqMixFrame — the room keeps one song's loudness all the way through (v0.9.33)", () => {
  const BAND = { low: 0.4, mid: 0.45, high: 0.15 }
  const bandPower = (k: number) => 10 ** ((k >= 0 ? k * EQ_DB : k * EQ_CUT_DB) / 10)
  const deckPower = (k: EqBands) => BAND.low * bandPower(k.low) + BAND.mid * bandPower(k.mid) + BAND.high * bandPower(k.high)
  const roomDb = (pos: number, curve: CrossfaderCurve, style: BassSwapStyle = 'instant') => {
    const f = frame(pos, style)
    const g = crossfaderGains(f.progress, curve)
    return 10 * Math.log10(g.a ** 2 * deckPower(f.a) + g.b ** 2 * deckPower(f.b))
  }
  for (const style of ['instant', 'gradual'] as const)
    it(`never 1 dB under one whole song, never 1.5 dB over (${style} bass swap)`, () => {
      sweep((pos) => {
        expect(roomDb(pos, AUTO_MIX_CROSSFADER_CURVE, style)).toBeGreaterThan(-1)
        expect(roomDb(pos, AUTO_MIX_CROSSFADER_CURVE, style)).toBeLessThan(1.5)
      })
    })
  it("on the hand crossfader's curve the same knobs sag below −2 dB — why automatic mixes do not use it", () => {
    expect(roomDb(52, 'power')).toBeLessThan(-2)
    expect(roomDb(66, 'power')).toBeLessThan(-2)
  })
})
