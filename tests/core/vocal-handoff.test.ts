import { describe, expect, it } from 'vitest'
import { CELL_NONE, CELL_UNSURE, CELL_VOCAL, VOCAL_CELL_SEC, type VocalTimeline } from '@/core/sound/vocal-timeline'
import {
  MIN_FADE_BARS,
  MIN_RUNWAY_BARS,
  bVoiceStarts,
  nextPhraseStartSec,
  PHRASE_BARS,
  planHandoff,
  plainTransitionClashSec,
  type HandoffPlan,
  type HandoffSide,
} from '@/core/vocal-handoff'

/** A timeline with voice on the given [from, to) seconds and nothing elsewhere. */
function timeline(durationSec: number, voices: [number, number][], cell: 1 | 2 = CELL_VOCAL): VocalTimeline {
  const cells = new Uint8Array(Math.floor(durationSec / VOCAL_CELL_SEC)).fill(CELL_NONE)
  for (const [a, b] of voices) for (let i = Math.round(a / VOCAL_CELL_SEC); i < Math.round(b / VOCAL_CELL_SEC); i++) cells[i] = cell
  return { cells, stereo: true }
}
const side = (durationSec: number, voices: [number, number][], bpm = 120, offsetSec = 0, cell: 1 | 2 = CELL_VOCAL): HandoffSide => ({
  timeline: timeline(durationSec, voices, cell),
  grid: { bpm, offsetSec },
  durationSec,
})

/** Independent of the planner: both decks audible from the join until A is out — is a voice ever over a voice? */
function voiceOverVoice(a: HandoffSide, b: HandoffSide, p: HandoffPlan): boolean {
  const ratio = a.grid.bpm / b.grid.bpm
  const voiced = (s: HandoffSide, sec: number) => s.timeline.cells[Math.floor(sec / VOCAL_CELL_SEC)] !== CELL_NONE
  for (let t = p.joinSec; t < p.fadeEndSec; t += 0.05) {
    const bSec = p.entrySec + (t - p.joinSec) * ratio
    if (voiced(a, t) && voiced(b, bSec)) return true
  }
  return false
}

// 120 BPM: one bar is 2 s. A sings 20–60 and 80–100; B is quiet for 16 bars, then sings from 32.
const A = side(120, [[20, 60], [80, 100]])
const B = side(120, [[32, 90]])

describe('bVoiceStarts', () => {
  it('finds a voice with the quiet before it, in whole bars', () => {
    expect(bVoiceStarts(B)).toEqual([{ voiceSec: 32, quietBars: 16 }])
  })
  it('skips a voice with too little quiet before it, and a song that opens singing', () => {
    expect(bVoiceStarts(side(120, [[0, 30], [36, 60]]))).toEqual([])
    expect(bVoiceStarts(side(120, [[6, 30], [36 + 2 * MIN_RUNWAY_BARS, 60]]))).toEqual([{ voiceSec: 44, quietBars: 7 }])
  })
  it('a voice starting mid-bar lines up with the yellow line before it', () => {
    expect(bVoiceStarts(side(120, [[33, 90]]))[0].voiceSec).toBe(32)
  })
})

describe('planHandoff', () => {
  const [bv] = bVoiceStarts(B)
  it('hands over exactly where A stops singing, with the full runway when there is time', () => {
    const p = planHandoff(A, 30, B, bv)!
    expect(p).toMatchObject({ joinSec: 44, entrySec: 16, handoffSec: 60, bVoiceSec: 32, fadeEndSec: 76, runwayBars: 8, fadeBars: 8, onVoiceEnd: true })
    expect(voiceOverVoice(A, B, p)).toBe(false)
  })
  // v0.9.17, the owner: "you mixed right away instead of waiting for the right moment". At 50 the old planner cut the runway to 4 bars and
  // joined on the very next bar (52); at 55 it slid the handoff into A's quiet and joined at 56 — one bar after the click, both times.
  it('never shortens the runway to fit the playhead: too late for this voice end → the next one, a whole phrase ahead', () => {
    for (const pos of [50, 55]) {
      const p = planHandoff(A, pos, B, bv)!
      expect(p).toMatchObject({ joinSec: 84, handoffSec: 100, runwayBars: PHRASE_BARS, onVoiceEnd: true })
      expect(voiceOverVoice(A, B, p)).toBe(false)
    }
  })
  it('A still quiet for long: the handoff can be a whole phrase after its voice end — never at a bar in between', () => {
    const a = side(160, [[20, 40], [120, 150]])
    const p = planHandoff(a, 35, B, bv)!
    expect(p).toMatchObject({ joinSec: 40, handoffSec: 56, runwayBars: PHRASE_BARS, onVoiceEnd: false })
    expect(voiceOverVoice(a, B, p)).toBe(false)
  })
  it('B with less than a phrase of quiet before its voice: half a phrase of runway, still not cut to the playhead', () => {
    const b6 = side(120, [[2, 12], [24, 90]]) // quiet 12–24: 6 bars before the voice at 24
    const [v] = bVoiceStarts(b6)
    expect(v.quietBars).toBe(6)
    expect(planHandoff(A, 30, b6, v)).toMatchObject({ joinSec: 52, handoffSec: 60, runwayBars: MIN_RUNWAY_BARS })
    expect(planHandoff(A, 53, b6, v)).toMatchObject({ joinSec: 92, handoffSec: 100 })
  })
  it('not enough quiet left for the fade → the next time A stops singing', () => {
    const p = planHandoff(A, 66, B, bv)!
    expect(p).toMatchObject({ handoffSec: 100, joinSec: 84, fadeEndSec: 116, onVoiceEnd: true })
    expect(voiceOverVoice(A, B, p)).toBe(false)
  })
  it('null — never a guess — when A has no clean moment left', () => {
    const short = side(104, [[20, 60], [80, 100]])
    expect(planHandoff(short, 66, B, bv)).toBeNull()
    expect(planHandoff(side(120, [[0, 120]]), 10, B, bv)).toBeNull()
  })
  it('a quiet stretch shorter than the minimum fade does not count', () => {
    const tight = side(120, [[20, 60], [60 + 2 * MIN_FADE_BARS - 2, 120]])
    expect(planHandoff(tight, 30, B, bv)).toBeNull()
  })
  it('unsure counts as voice, and a gap of 2 s or less is still voice (the owner rule)', () => {
    expect(planHandoff(side(120, [[20, 120]], 120, 0, CELL_UNSURE), 10, B, bv)).toBeNull()
    expect(planHandoff(side(120, [[20, 60], [62, 120]]), 10, B, bv)).toBeNull()
  })
  it('different BPMs: bars line up, each side in its own seconds', () => {
    const b100 = side(150, [[48, 120]], 100) // a bar of B is 2.4 s
    const [v] = bVoiceStarts(b100)
    expect(v.voiceSec).toBeCloseTo(48)
    const p = planHandoff(A, 30, b100, v)!
    expect(p.runwayBars).toBe(8)
    expect(p.entrySec).toBeCloseTo(48 - 8 * 2.4)
    expect(p.joinSec).toBeCloseTo(44)
    expect(voiceOverVoice(A, b100, p)).toBe(false)
  })
  it('joins on a yellow line of A and enters B on a yellow line of B, with a grid offset', () => {
    const a = side(120, [[20, 60.3]], 120, 0.7)
    const b = side(120, [[32.9, 90]], 120, 1.1)
    const [v] = bVoiceStarts(b)
    const p = planHandoff(a, 30, b, v)!
    const onLine = (sec: number, off: number) => Math.abs(((sec - off) / 2) - Math.round((sec - off) / 2)) < 1e-6
    expect(onLine(p.joinSec, 0.7) && onLine(p.handoffSec, 0.7) && onLine(p.entrySec, 1.1) && onLine(p.bVoiceSec, 1.1)).toBe(true)
    expect(p.handoffSec).toBeCloseTo(60.7)
    expect(voiceOverVoice(a, b, p)).toBe(false)
  })
})

describe('nextPhraseStartSec (v0.9.17)', () => {
  const g = { bpm: 120, offsetSec: 0 } // a phrase of 8 bars is 16 s
  const t = timeline(120, [[20, 60], [80, 100]])
  it('counts whole phrases from where the voice last started or stopped', () => {
    expect(nextPhraseStartSec(g, t, 120, 30)).toEqual({ sec: 36, by: 'voice' })
    expect(nextPhraseStartSec(g, t, 120, 36)).toEqual({ sec: 52, by: 'voice' }) // on the line itself → the next one
    expect(nextPhraseStartSec(g, t, 120, 61)).toEqual({ sec: 76, by: 'voice' })
  })
  it('the next voice change is a phrase start too, even when the verse is not a multiple of 8 bars', () => {
    expect(nextPhraseStartSec(g, t, 120, 70)).toEqual({ sec: 76, by: 'voice' })
    expect(nextPhraseStartSec(g, t, 120, 77)).toEqual({ sec: 80, by: 'voice' }) // 92 would be past the voice coming back at 80
  })
  it('in the intro, counted back from the first voice', () => {
    expect(nextPhraseStartSec(g, t, 120, 1)).toEqual({ sec: 4, by: 'voice' })
  })
  it('no voice to count from: from the first yellow line, and it says so', () => {
    expect(nextPhraseStartSec({ bpm: 120, offsetSec: 1 }, null, 120, 20)).toEqual({ sec: 33, by: 'grid' })
    expect(nextPhraseStartSec({ bpm: 120, offsetSec: 1 }, timeline(120, []), 120, 20)).toEqual({ sec: 33, by: 'grid' })
  })
  it("no phrase start left before A's last bars: the next yellow line, said as such — never a wait past the song's end (review, 05/10)", () => {
    expect(nextPhraseStartSec({ bpm: 120, offsetSec: 0 }, null, 120, 113)).toEqual({ sec: 114, by: 'end' })
    expect(nextPhraseStartSec(g, timeline(120, [[20, 100]]), 120, 107)).toEqual({ sec: 108, by: 'end' })
    // From 101 the next phrase start is 116, with under 4 bars of A left after it: the next bar. From 85 the voice end at 100 still leaves 10.
    expect(nextPhraseStartSec(g, timeline(120, [[20, 100]]), 120, 101)).toEqual({ sec: 102, by: 'end' })
    expect(nextPhraseStartSec(g, timeline(120, [[20, 100]]), 120, 85)).toEqual({ sec: 100, by: 'voice' })
  })
  it('a voice that starts mid-bar counts from the yellow line before it, and one that stops mid-bar from the line after', () => {
    expect(nextPhraseStartSec(g, timeline(120, [[21, 61]]), 120, 30)).toEqual({ sec: 36, by: 'voice' })
    expect(nextPhraseStartSec(g, timeline(120, [[21, 61]]), 120, 63)).toEqual({ sec: 78, by: 'voice' })
  })
})

describe('fade end at the song end', () => {
  it('never lies past the quiet it was planned in — the engine stops at the duration and would never reach it', () => {
    const endsQuiet = side(80.0000001, [[20, 60]])
    const p = planHandoff(endsQuiet, 30, B, bVoiceStarts(B)[0])!
    expect(p.fadeEndSec).toBeLessThanOrEqual(endsQuiet.durationSec)
  })
})

describe('plainTransitionClashSec', () => {
  it('clean when B is quiet through the whole fade', () => {
    expect(plainTransitionClashSec(A, 30, B, 0, 8)).toBeNull()
  })
  it('names the first second both sing — half a bar early, since the real entry can move that much to land on a yellow line', () => {
    expect(plainTransitionClashSec(A, 30, B, 30, 8)).toBeCloseTo(33)
  })
  it('a B voice starting just after the fade still counts: the fade is widened by half a bar', () => {
    // B from 23: its voice comes in 9 s after the join at 32 — past an 8 s fade, inside 8 s + half a bar (+ B's own half-bar margin).
    expect(plainTransitionClashSec(A, 30, B, 23, 8)).toBeCloseTo(40)
  })
  it("SYNC's half/double reading changes how fast B's seconds run against A's", () => {
    // A 120, B 240 that SYNC plays as 120 (syncMult 0.5): B at its own speed, one B second per A second; voice at 32 - 0.5 → A 37.5.
    const b240 = side(120, [[32, 90]], 240)
    expect(plainTransitionClashSec(A, 30, b240, 26, 8, 0.5)).toBeCloseTo(37.5)
    // Read as straight (B pitched down to 120), B's voice would arrive at A 43 — past the window: the clash would be missed.
    expect(plainTransitionClashSec(A, 30, b240, 26, 8, 1)).toBeNull()
  })
})

describe('fade end at the song end', () => {
  it('never lies past the quiet it was planned in — the engine stops at the duration and would never reach it', () => {
    const endsQuiet = side(80.0000001, [[20, 60]])
    const p = planHandoff(endsQuiet, 30, B, bVoiceStarts(B)[0])!
    expect(p.fadeEndSec).toBeLessThanOrEqual(endsQuiet.durationSec)
  })
})

describe('plainTransitionClashSec, joined at a phrase start (v0.9.17)', () => {
  it('reads the voices from where B really joins, not from the next bar', () => {
    // From 62, B entering at 26: on the next bar (64) B's voice (32) arrives at A 70 — A is quiet until 80, clean. Joined at the phrase start
    // (76) the same voice arrives at A 82, with A singing again from 80: a clash the next-bar reading would have missed.
    expect(plainTransitionClashSec(A, 62, B, 26, 8)).toBeNull()
    expect(plainTransitionClashSec(A, 62, B, 26, 8, 1, 76)).toBeCloseTo(81)
  })
})

describe('plainTransitionClashSec, A side', () => {
  it('clean when A is quiet through the whole fade', () => {
    expect(plainTransitionClashSec(A, 61, B, 40, 8)).toBeNull()
  })
})
