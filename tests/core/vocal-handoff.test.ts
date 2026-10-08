import { describe, expect, it } from 'vitest'
import { CELL_NONE, CELL_UNSURE, CELL_VOCAL, VOCAL_CELL_SEC, type VocalTimeline } from '@/core/sound/vocal-timeline'
import {
  MIN_BARS_AFTER_MIX,
  MIN_FADE_BARS,
  MIN_RUNWAY_BARS,
  bVoiceStarts,
  enoughSongAfterMix,
  handoffEndInB,
  nextPhraseStartSec,
  RUN_IN_BARS,
  firstVoiceInSec,
  planHandoff,
  quietJoinSec,
  plainMixEndInB,
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

/** v0.9.63, the owner's rule (07/10): from the join until A is out, A never sings — B is never heard over A's voice, drums or otherwise. */
function aSingsWhileBPlays(a: HandoffSide, p: HandoffPlan): boolean {
  for (let t = p.joinSec; t < p.fadeEndSec; t += 0.05) if (a.timeline.cells[Math.floor(t / VOCAL_CELL_SEC)] !== CELL_NONE) return true
  return false
}

describe('planHandoff (v0.9.63: B joins only after A has stopped singing)', () => {
  const [bv] = bVoiceStarts(B)
  it('joins on the line where A stops singing, runs in with no voice, and B sings when A is out', () => {
    // A quiet 60–80: 10 bars → the longest run-in that fits is 8; B sings at 32, so it enters 8 bars earlier, at 16.
    const p = planHandoff(A, 30, B, bv)!
    expect(p).toMatchObject({ joinSec: 60, entrySec: 16, handoffSec: 68, bVoiceSec: 32, fadeEndSec: 76, runwayBars: 8, onVoiceEnd: true })
    expect(aSingsWhileBPlays(A, p)).toBe(false)
    expect(voiceOverVoice(A, B, p)).toBe(false)
  })
  it('the old plan put B under A’s last 8 bars of singing — this one never does, from any click', () => {
    for (let pos = 0; pos < 100; pos += 0.5) {
      const p = planHandoff(A, pos, B, bv)
      if (p) expect(aSingsWhileBPlays(A, p)).toBe(false)
    }
  })
  it('16 bars when both quiets have room — what DJs use in house and techno', () => {
    const a = side(160, [[20, 40], [120, 150]])
    const p = planHandoff(a, 35, B, bv)!
    expect(p).toMatchObject({ joinSec: 40, entrySec: 0, handoffSec: 56, fadeEndSec: 72, runwayBars: 16, onVoiceEnd: true })
    expect(RUN_IN_BARS[0]).toBe(16)
    expect(aSingsWhileBPlays(a, p)).toBe(false)
    expect(voiceOverVoice(a, B, p)).toBe(false)
  })
  it('too late for this voice end → a whole phrase later in the same quiet if it still fits, else A’s next voice end', () => {
    // From 61 the line at 60 is behind; 76 leaves 2 bars of quiet — no run-in fits. The next voice end is 100, with 10 bars after it.
    expect(planHandoff(A, 61, B, bv)).toMatchObject({ joinSec: 100, fadeEndSec: 116, runwayBars: 8, onVoiceEnd: true })
    const a = side(200, [[20, 40], [150, 190]]) // quiet 40–150
    expect(planHandoff(a, 41, B, bv)).toMatchObject({ joinSec: 56, runwayBars: 16, onVoiceEnd: false })
  })
  it('B with 6 quiet bars before its voice: a run-in of 4', () => {
    const b6 = side(120, [[2, 12], [24, 90]]) // quiet 12–24: 6 bars before the voice at 24
    const [v] = bVoiceStarts(b6)
    expect(v.quietBars).toBe(6)
    expect(planHandoff(A, 30, b6, v)).toMatchObject({ joinSec: 60, entrySec: 16, handoffSec: 64, fadeEndSec: 68, runwayBars: MIN_RUNWAY_BARS })
  })
  it('null — never a guess — when A has no clean moment left', () => {
    const short = side(104, [[20, 60], [80, 100]])
    expect(planHandoff(short, 66, B, bv)).toBeNull()
    expect(planHandoff(side(120, [[0, 120]]), 10, B, bv)).toBeNull()
  })
  it('a quiet stretch shorter than the shortest run-in does not count', () => {
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
    expect(p.joinSec).toBeCloseTo(60)
    expect(voiceOverVoice(A, b100, p)).toBe(false)
  })
  it('joins on a yellow line of A and enters B on a yellow line of B, with a grid offset', () => {
    const a = side(120, [[20, 60.3]], 120, 0.7)
    const b = side(120, [[32.9, 90]], 120, 1.1)
    const [v] = bVoiceStarts(b)
    const p = planHandoff(a, 30, b, v)!
    const onLine = (sec: number, off: number) => Math.abs(((sec - off) / 2) - Math.round((sec - off) / 2)) < 1e-6
    expect(onLine(p.joinSec, 0.7) && onLine(p.handoffSec, 0.7) && onLine(p.fadeEndSec, 0.7) && onLine(p.entrySec, 1.1) && onLine(p.bVoiceSec, 1.1)).toBe(true)
    expect(p.joinSec).toBeCloseTo(60.7)
    expect(aSingsWhileBPlays(a, p)).toBe(false)
    expect(voiceOverVoice(a, b, p)).toBe(false)
  })
})

describe('quietJoinSec (v0.9.63: energy points, Mix-in pads, excellent pairs)', () => {
  const need = 9 // an 8 s mix and half a bar
  it('in a verse: waits for the line where A stops singing', () => {
    expect(quietJoinSec(A, 30, need)).toEqual({ sec: 60, onVoiceEnd: true })
  })
  it('a quiet too short for the whole mix is skipped — the next voice end', () => {
    expect(quietJoinSec(A, 61, need)).toEqual({ sec: 100, onVoiceEnd: true })
  })
  it('null when A has no quiet moment left with room for the mix and its last bars', () => {
    expect(quietJoinSec(A, 101, need)).toBeNull()
    expect(quietJoinSec(side(120, [[0, 120]]), 10, need)).toBeNull()
  })
  it("in A's intro: phrases counted back from A's first voice, as nextPhraseStartSec counts them (a 6-bar intro would put a forward count 2 bars off)", () => {
    const intro = side(120, [[44, 100]]) // the voice starts on line 44: phrase lines at 12 and 28, not 16 and 32
    expect(quietJoinSec(intro, 1, need)).toEqual({ sec: 12, onVoiceEnd: false })
    expect(nextPhraseStartSec({ bpm: 120, offsetSec: 0 }, intro.timeline, 120, 1).sec).toBe(12)
  })
  it('a song with no voice: whole phrases from its first yellow line', () => {
    expect(quietJoinSec(side(120, []), 30, need)).toEqual({ sec: 32, onVoiceEnd: false })
  })
  it('never joins where A sings during the mix, from any click', () => {
    for (let pos = 0; pos < 110; pos += 0.5) {
      const j = quietJoinSec(A, pos, need)
      if (j) expect(firstVoiceInSec(A, j.sec, j.sec + need)).toBeNull()
    }
  })
})

describe('firstVoiceInSec', () => {
  it('the first second A sings inside the window, or null', () => {
    expect(firstVoiceInSec(A, 50, 70)).toBe(50)
    expect(firstVoiceInSec(A, 60, 80)).toBeNull()
    expect(firstVoiceInSec(A, 75, 85)).toBe(80)
  })
  it('a yellow line a float hair before a voice end is not a voice (170.99999999999892 against 171, one of his House songs)', () => {
    expect(firstVoiceInSec(A, 60 - 1e-12, 70)).toBeNull()
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

describe('enough of B left after the mix (v0.9.23)', () => {
  it("the owner's case: a 2:24 song whose last voice starts at 2:18 is over before the handoff's fade is", () => {
    // 128 BPM like his Rihanna rework; B quiet for 16 bars before 2:18, then sings to the end
    const bpm = 128
    const bar = (60 / bpm) * 4
    const b = side(144, [[20, 100], [138, 144]], bpm)
    const a = side(240, [[30, 80], [140, 200]], bpm)
    const late = bVoiceStarts(b).find((v) => v.voiceSec > 130)!
    expect(late).toBeTruthy()
    const plan = planHandoff(a, 0, b, late)!
    expect(plan).toBeTruthy() // the planner alone offers it — that was the bug
    expect(enoughSongAfterMix(b.durationSec, b.grid, handoffEndInB(plan))).toBe(false)
    // v0.9.63: A is out when B's voice comes in, so that is where the mix ends in B.
    expect(handoffEndInB(plan)).toBe(plan.bVoiceSec)
    expect(b.durationSec - handoffEndInB(plan)).toBeLessThan(MIN_BARS_AFTER_MIX * bar)
  })
  it(`needs ${MIN_BARS_AFTER_MIX} of B's own bars after the mix, no fewer`, () => {
    const grid = { bpm: 120, offsetSec: 0 } // 2 s a bar
    expect(enoughSongAfterMix(200, grid, 200 - MIN_BARS_AFTER_MIX * 2)).toBe(true)
    expect(enoughSongAfterMix(200, grid, 200 - MIN_BARS_AFTER_MIX * 2 + 0.01)).toBe(false)
    // no grid yet: 120 BPM is assumed
    expect(enoughSongAfterMix(200, null, 100)).toBe(true)
    expect(enoughSongAfterMix(200, null, 160)).toBe(false)
  })
})

describe('a plain transition from a saved second (v0.9.26: Mix-in pads, excellent pairs)', () => {
  it('ends half again past the crossfade and two bars of B later (one more since v0.9.33: the kick lock may start it a bar late)', () => {
    expect(plainMixEndInB(10, { bpm: 120 }, 8)).toBeCloseTo(10 + 12 + 2 * 2, 9)
    expect(plainMixEndInB(10, { bpm: 128 }, 8)).toBeCloseTo(10 + 12 + 2 * 1.875, 9)
    // no grid, or a grid without a tempo: 120 BPM is assumed, never a zero-length bar
    expect(plainMixEndInB(10, null, 8)).toBeCloseTo(26, 9)
    expect(plainMixEndInB(10, { bpm: 0 }, 8)).toBeCloseTo(26, 9)
  })
  it('a pad saved at 2:15 of a 3:00 song is refused — 29 s left, 24 bars are 45; one at 1:58 is not', () => {
    const grid = { bpm: 128 }
    expect(enoughSongAfterMix(180, grid, plainMixEndInB(135, grid, 8))).toBe(false)
    expect(enoughSongAfterMix(180, grid, plainMixEndInB(118, grid, 8))).toBe(true)
  })
  it('a library BPM of 0 does not make every bar zero long', () => {
    expect(enoughSongAfterMix(180, { bpm: 0 }, 170)).toBe(false)
  })
})
