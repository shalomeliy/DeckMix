import { describe, expect, it } from 'vitest'
import { EQ_KILL } from '@/core/eq-mix'
import { CELL_NONE, CELL_VOCAL, VOCAL_CELL_SEC, type VocalTimeline } from '@/core/sound/vocal-timeline'
import { MIN_BARS_AFTER_MIX, PHRASE_BARS, type HandoffSide } from '@/core/vocal-handoff'
import { SWAP_BARS, planVocalSwap, swapEntries, swapIncoming, vocalSwapFrame, type VocalSwapPlan } from '@/core/vocal-swap-mix'

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
  it('counts, by reason, every voice it cannot use — none is dropped quietly', () => {
    // 0.5–2 and 10–13.5: too short for two bars alone; 150–196: B is over right after the mix.
    const r = swapEntries(side(200, [[0.5, 2], [10, 13.5], [150, 196]]))
    expect(r.entries).toEqual([])
    expect(r).toMatchObject({ short: 2, early: 0, late: 1 })
    const early = swapEntries(side(200, [[2, 30]]))
    expect(early.early).toBe(1)
  })
  it(`keeps ${MIN_BARS_AFTER_MIX} bars of B after the mix`, () => {
    // Mix ends 2.25 bars after the voice line: 4.5 s. 24 bars = 48 s.
    expect(swapEntries(side(32 + 4.5 + 48, [[32, 60]])).entries).toHaveLength(1)
    expect(swapEntries(side(32 + 4.5 + 47, [[32, 60]])).entries).toHaveLength(0)
  })
})

describe('planVocalSwap', () => {
  const [entry] = swapEntries(B).entries
  it("starts on the line A's voice ends on, and B is two bars before its voice", () => {
    const p = planVocalSwap(A, 30, B, entry)!
    expect(p).toMatchObject({ joinSec: 60, entrySec: 28, bVoiceSec: 32, voiceSec: 64, swapSec: 60 + SWAP_BARS * 2, onVoiceEnd: true })
    expect(p.endSec).toBeCloseTo(68.5)
  })
  // He asked for "about 5–10 s". It is 4 bars and a beat: 7.0 s at 140, 8.0 at 128, 10.2 at 100 — a hair over 10 below ~102 BPM.
  it('lasts about 5–10 seconds from 100 to 140 BPM (10.2 s at 100)', () => {
    for (const bpm of [100, 110, 122, 128, 140]) {
      const a = side(400, [[20, 60]], bpm)
      const b = side(400, [[40, 120]], bpm)
      const p = planVocalSwap(a, 0, b, swapEntries(b).entries[0])!
      const sec = p.endSec - p.joinSec
      expect(sec).toBeGreaterThanOrEqual(5)
      expect(sec).toBeLessThanOrEqual(10.5) // 100 BPM: 4 bars and a beat = 10.2 s
    }
  })
  it('never lets A sing again before the mix is over, and waits a whole phrase when it would', () => {
    // A's quiet after 60 is only 6 s (3 bars) before it sings at 66: too short, so the next voice end — 100.
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
  it("in order: A's MID, then A's HIGH, then B's voice over A's bass, then the swap", () => {
    expect(at(59.9)).toEqual({ progress: 0, a: own.a, b: swapIncoming(own.b) })
    expect(at(61).a.mid).toBeCloseTo(-0.5)
    expect(at(61).a.high).toBe(0)
    expect(at(62).a.mid).toBe(EQ_KILL)
    expect(at(63).a.high).toBeCloseTo(-0.5)
    const alone = at(65)
    expect(alone.a).toEqual({ low: 0, mid: EQ_KILL, high: EQ_KILL })
    expect(alone.b).toEqual({ low: EQ_KILL, mid: 0, high: EQ_KILL })
    expect(alone.progress).toBe(0.5)
    expect(at(62).progress).toBe(0) // B is silent until its voice line
    const after = at(68.2)
    expect(after.a.low).toBe(EQ_KILL)
    expect(after.b).toEqual(own.b)
    expect(at(p.endSec).progress).toBe(1)
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
    }
  })
})
