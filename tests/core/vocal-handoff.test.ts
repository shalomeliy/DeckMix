import { describe, expect, it } from 'vitest'
import { CELL_NONE, CELL_UNSURE, CELL_VOCAL, VOCAL_CELL_SEC, type VocalTimeline } from '@/core/sound/vocal-timeline'
import {
  MIN_FADE_BARS,
  MIN_RUNWAY_BARS,
  bVoiceStarts,
  handoffProgress,
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
  it('shortens the runway before it moves the handoff', () => {
    const p = planHandoff(A, 50, B, bv)!
    expect(p).toMatchObject({ joinSec: 52, handoffSec: 60, runwayBars: MIN_RUNWAY_BARS, onVoiceEnd: true })
    expect(voiceOverVoice(A, B, p)).toBe(false)
  })
  it('A already quiet: hands over later in the same quiet, if A can still go down there', () => {
    const p = planHandoff(A, 55, B, bv)!
    expect(p).toMatchObject({ joinSec: 56, handoffSec: 64, fadeEndSec: 80, onVoiceEnd: false })
    expect(voiceOverVoice(A, B, p)).toBe(false)
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

describe('fade end at the song end', () => {
  it('never lies past the quiet it was planned in — the engine stops at the duration and would never reach it', () => {
    const endsQuiet = side(80.0000001, [[20, 60]])
    const p = planHandoff(endsQuiet, 30, B, bVoiceStarts(B)[0])!
    expect(p.fadeEndSec).toBeLessThanOrEqual(endsQuiet.durationSec)
  })
})

describe('handoffProgress', () => {
  const p = { joinSec: 44, handoffSec: 60, fadeEndSec: 76 }
  it('B rises to the middle over the runway, then A goes down over the fade', () => {
    expect(handoffProgress(p, 40)).toBe(0)
    expect(handoffProgress(p, 52)).toBeCloseTo(0.25)
    expect(handoffProgress(p, 60)).toBeCloseTo(0.5)
    expect(handoffProgress(p, 68)).toBeCloseTo(0.75)
    expect(handoffProgress(p, 80)).toBe(1)
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

describe('handoffProgress', () => {
  const p = { joinSec: 44, handoffSec: 60, fadeEndSec: 76 }
  it('B rises to the middle over the runway, then A goes down over the fade', () => {
    expect(handoffProgress(p, 40)).toBe(0)
    expect(handoffProgress(p, 52)).toBeCloseTo(0.25)
    expect(handoffProgress(p, 60)).toBeCloseTo(0.5)
    expect(handoffProgress(p, 68)).toBeCloseTo(0.75)
    expect(handoffProgress(p, 80)).toBe(1)
  })
})

describe('plainTransitionClashSec, A side', () => {
  it('clean when A is quiet through the whole fade', () => {
    expect(plainTransitionClashSec(A, 61, B, 40, 8)).toBeNull()
  })
})
