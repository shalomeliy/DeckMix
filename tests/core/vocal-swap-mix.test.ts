import { describe, expect, it } from 'vitest'
import { EQ_CUT_DB, EQ_DB } from '@/core/constants'
import { EQ_KILL, type EqBands } from '@/core/eq-mix'
import { crossfaderGains } from '@/core/fx'
import { CELL_NONE, CELL_VOCAL, VOCAL_CELL_SEC, type VocalTimeline } from '@/core/sound/vocal-timeline'
import { MIN_BARS_AFTER_MIX, PHRASE_BARS, type HandoffSide } from '@/core/vocal-handoff'
import { SWAP_BARS, SWAP_CROSSFADER_CURVE, planVocalSwap, swapEntries, swapIncoming, vocalSwapFrame, type VocalSwapPlan } from '@/core/vocal-swap-mix'

function timeline(durationSec: number, voices: [number, number][]): VocalTimeline {
  const cells = new Uint8Array(Math.floor(durationSec / VOCAL_CELL_SEC)).fill(CELL_NONE)
  for (const [a, b] of voices) for (let i = Math.round(a / VOCAL_CELL_SEC); i < Math.round(b / VOCAL_CELL_SEC); i++) cells[i] = CELL_VOCAL
  return { cells, stereo: true }
}
const side = (durationSec: number, voices: [number, number][], bpm = 120, offsetSec = 0): HandoffSide => ({
  timeline: timeline(durationSec, voices),
  grid: { bpm, offsetSec },
  durationSec,
})

// 120 BPM: a bar is 2 s. A sings 20–60 and 80–100. B sings 32–90 (and is long enough after it).
const A = side(200, [[20, 60], [80, 100]])
const B = side(200, [[32, 90]])
const own = { a: { low: 0, mid: 0, high: 0 }, b: { low: 0, mid: 0, high: 0 } }

describe('swapEntries', () => {
  it("enters on the yellow line B's voice starts on", () => {
    expect(swapEntries(B).entries).toEqual([{ voiceSec: 32 }])
    expect(swapEntries(side(200, [[33, 90]])).entries).toEqual([{ voiceSec: 32 }])
  })
  it('a mark on a yellow line just past a half-second cell is not read a bar early (his marks, 05/10)', () => {
    // Grid lines at 0.16 + 2k. His voice starts on the line at 32.16; the timeline's cell starts at 32.0, before that line.
    const b = side(200, [[32.16, 90]], 120, 0.16)
    expect(swapEntries(b).entries[0].voiceSec).toBeCloseTo(32.16)
  })
  it('a voice from the first half second, on a grid whose first line is later, enters on that first line, not before 0', () => {
    const b = side(200, [[0, 40]], 120, 0.6)
    expect(swapEntries(b).entries[0].voiceSec).toBeCloseTo(0.6)
  })
  it('B sings until the swap: a voice shorter than the 3 bars before it is left out', () => {
    expect(swapEntries(side(200, [[32, 37.5]])).entries).toHaveLength(0)
    expect(swapEntries(side(200, [[32, 38]])).entries).toHaveLength(1)
  })
  it('counts, by reason, every voice it cannot use — none is dropped quietly', () => {
    // 0.5–2 and 10–13.5: shorter than three bars from their line; 150–196: B is over right after the mix.
    const r = swapEntries(side(200, [[0.5, 2], [10, 13.5], [150, 196]]))
    expect(r.entries).toEqual([])
    expect(r).toMatchObject({ short: 2, late: 1 })
  })
  it(`keeps ${MIN_BARS_AFTER_MIX} bars of B after the mix`, () => {
    // B starts on its voice line and the mix ends 3.25 bars later: 6.5 s. 24 bars = 48 s.
    expect(swapEntries(side(32 + 6.5 + 48, [[32, 60]])).entries).toHaveLength(1)
    expect(swapEntries(side(32 + 6.5 + 47, [[32, 60]])).entries).toHaveLength(0)
  })
})

describe('planVocalSwap', () => {
  const [entry] = swapEntries(B).entries
  it("starts on the line A's voice ends on, with B on its own voice line at that same moment", () => {
    const p = planVocalSwap(A, 30, B, entry)!
    expect(p).toMatchObject({ joinSec: 60, entrySec: 32, bVoiceSec: 32, voiceSec: 60, swapSec: 60 + SWAP_BARS * 2, onVoiceEnd: true })
    expect(p.endSec).toBeCloseTo(66.5)
  })
  // He asked for "about 5–10 s". 3 bars and a beat: 5.6 s at 140, 6.1 at 128, 7.8 at 100.
  it('lasts 5–10 seconds from 100 to 140 BPM', () => {
    for (const bpm of [100, 110, 122, 128, 140]) {
      const a = side(400, [[20, 60]], bpm)
      const b = side(400, [[40, 120]], bpm)
      const p = planVocalSwap(a, 0, b, swapEntries(b).entries[0])!
      const sec = p.endSec - p.joinSec
      expect(sec).toBeGreaterThanOrEqual(5)
      expect(sec).toBeLessThanOrEqual(10)
    }
  })
  it('never lets A sing again before the mix is over, and waits a whole phrase when it would', () => {
    // A's quiet after 60 is only 6 s before it sings at 66, and the mix takes 6.5: too short, so the next voice end — 100.
    const a = side(200, [[20, 60], [66, 100]])
    expect(planVocalSwap(a, 30, B, entry)!.joinSec).toBe(100)
    // Past A's voice end: a whole phrase after it, not the next bar.
    expect(planVocalSwap(A, 61, B, entry)!.joinSec).toBe(100) // 76 would run into A's voice at 80
    const p = planVocalSwap(side(200, [[20, 60]]), 61, B, entry)!
    expect(p.joinSec).toBe(60 + PHRASE_BARS * 2)
    expect(p.onVoiceEnd).toBe(false)
  })
  it('null when A has no quiet stretch long enough left', () => {
    expect(planVocalSwap(side(100, [[0, 95]]), 10, B, entry)).toBeNull()
  })
})

describe('vocalSwapFrame', () => {
  const p: VocalSwapPlan = planVocalSwap(A, 30, B, swapEntries(B).entries[0])!
  const at = (pos: number) => vocalSwapFrame(p, pos, 2, own)
  it("in order: A's MID with B coming in, then A's HIGH, then B's voice over A's bass, then the swap", () => {
    expect(at(59.9)).toEqual({ progress: 0, a: own.a, b: swapIncoming(own.b) })
    // Half a bar in: A's MID halfway down on the power curve (−3 dB, not the knob's straight midpoint), B halfway up.
    expect(at(61).a.mid).toBeCloseTo(-3 / EQ_CUT_DB)
    expect(at(61).a.high).toBe(0)
    expect(at(61).progress).toBeCloseTo(0.25)
    expect(at(62).a.mid).toBe(EQ_KILL)
    expect(at(63).a.high).toBeCloseTo(-3 / EQ_CUT_DB)
    const alone = at(65)
    expect(alone.a).toEqual({ low: 0, mid: EQ_KILL, high: EQ_KILL })
    // B keeps its HIGH: its MID alone was what the owner heard as "muffled" (06/10).
    expect(alone.b).toEqual({ low: EQ_KILL, mid: 0, high: 0 })
    expect(alone.progress).toBe(0.5)
    const after = at(66.25)
    expect(after.a.low).toBe(EQ_KILL)
    expect(after.b).toEqual(own.b)
    expect(at(p.endSec).progress).toBe(1)
  })
  it('B is heard from the first moment of the mix: no stretch where neither song plays', () => {
    expect(crossfaderGains(at(60.1).progress, SWAP_CROSSFADER_CURVE).b).toBeGreaterThan(0.05)
    expect(crossfaderGains(at(61).progress, SWAP_CROSSFADER_CURVE).b).toBeGreaterThan(0.7)
  })
  it('never two basses at once', () => {
    for (let t = 55; t <= 70; t += 0.05) {
      const f = at(t)
      expect(f.a.low > -0.5 && f.b.low > -0.5 && f.progress > 0).toBe(false)
    }
  })
  it('never turns a knob the owner had lower back up', () => {
    const low = { a: { low: -0.2, mid: -0.3, high: -0.6 }, b: { low: -0.1, mid: -0.7, high: 0.3 } }
    for (let t = 55; t <= 70; t += 0.25) {
      const f = vocalSwapFrame(p, t, 2, low)
      expect(f.a.low).toBeLessThanOrEqual(low.a.low)
      expect(f.a.mid).toBeLessThanOrEqual(low.a.mid)
      expect(f.a.high).toBeLessThanOrEqual(low.a.high)
      expect(f.b.mid).toBe(low.b.mid)
      expect(f.b.high).toBe(low.b.high)
    }
  })

  // The owner, 06/10: "you take the volume to 0, nothing is heard" — and "in a mix clear music is always heard". A model of what reaches
  // the room: a song's power split into its three bands (bass .4, mids .45, highs .15 — a dance track, roughly), each band scaled by its
  // knob in dB, each deck by its crossfader gain squared, the two decks adding as power. One whole song is 0 dB. v0.9.28 sat near −4 dB
  // for two bars here (A's bass alone, B silent — and bass alone is much less than that on small speakers); v0.9.31 on the mixer's usual
  // curve still sat at −3 dB for two bars and jumped on the swap.
  const BAND = { low: 0.4, mid: 0.45, high: 0.15 }
  const bandPower = (k: number) => 10 ** ((k >= 0 ? k * EQ_DB : k * EQ_CUT_DB) / 10)
  const deckPower = (k: EqBands) => BAND.low * bandPower(k.low) + BAND.mid * bandPower(k.mid) + BAND.high * bandPower(k.high)
  const roomDb = (pos: number, curve = SWAP_CROSSFADER_CURVE) => {
    const f = at(pos)
    const g = crossfaderGains(f.progress, curve)
    return 10 * Math.log10(g.a ** 2 * deckPower(f.a) + g.b ** 2 * deckPower(f.b))
  }
  it('the room hears one whole song all the way through: never 1 dB under it, never 1.5 dB over', () => {
    for (let t = 58; t <= 68; t += 0.02) {
      expect(roomDb(t)).toBeGreaterThan(-1)
      expect(roomDb(t)).toBeLessThan(1.5)
    }
  })
  it("on the mixer's usual curve the same knobs would sag to −3 dB — why this mix uses its own", () => {
    expect(roomDb(65, 'power')).toBeLessThan(-2.5)
  })
})
