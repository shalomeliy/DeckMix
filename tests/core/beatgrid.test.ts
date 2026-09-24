import { describe, expect, it } from 'vitest'
import {
  bpmFromTaps,
  doubleGrid,
  estimateBeatGrid,
  nextBarLineSec,
  barLineCrossed,
  halveGrid,
  phaseDeltaSec,
  quantizeToGrid,
  setDownbeatAt,
  shiftGrid,
} from '@/core/beatgrid.ts'
import type { BeatGrid } from '@/core/types.ts'

const FPS = 200

/** A synthetic click track: one unit-height onset every `lagFrames`, else silence. */
function clickTrack(lagFrames: number, totalFrames: number, phaseFrames = 0): Float32Array {
  const onsets = new Float32Array(totalFrames)
  for (let i = phaseFrames; i < totalFrames; i += lagFrames) onsets[i] = 1
  return onsets
}

describe('estimateBeatGrid', () => {
  it('recovers the beat period of a synthetic click track, up to octave ambiguity', () => {
    // A perfectly periodic pulse train is, by construction, equally periodic
    // at every integer multiple of its true period — autocorrelation cannot
    // tell period P from 2P or P/2 on a signal this clean, only real music's
    // amplitude/timbre variation resolves that. This is exactly the ambiguity
    // halveGrid/doubleGrid exist to let the user correct by hand, not a bug
    // to hide behind a rigged test. What must hold: the found period is a
    // small integer multiple or submultiple of the true one, never an
    // unrelated number.
    for (const bpm of [120, 128, 174]) {
      const lag = Math.round((60 / bpm) * FPS)
      const onsets = clickTrack(lag, 2000)
      const result = estimateBeatGrid(onsets, FPS)
      expect(result).not.toBeNull()
      expect(result!.confident).toBe(true)
      const foundLag = Math.round((60 / result!.grid.bpm) * FPS)
      const ratio = foundLag / lag
      expect([0.5, 1, 2]).toContain(ratio)
    }
  })

  it('recovers a fractional tempo finely enough not to drift across a whole song', () => {
    // 100.3 BPM is 119.64 frames per beat — not a whole number of frames. A
    // whole-frame lag can only say ~100.0 or ~100.8, and a 0.3 BPM error is
    // half a beat of drift after ~170 beats (the middle of a 5-minute song).
    const trueBpm = 100.3
    const period = (60 / trueBpm) * FPS
    const frames = 60000
    const onsets = new Float32Array(frames)
    for (let k = 0; Math.round(k * period) < frames; k++) onsets[Math.round(k * period)] = 1
    const result = estimateBeatGrid(onsets, FPS)
    expect(result).not.toBeNull()
    expect(Math.abs(result!.grid.bpm - trueBpm)).toBeLessThan(0.05)
  })

  it('refines around a rounded tag tempo instead of trusting the blind search', () => {
    // Tagged "100", really 100.3: the grid must land on 100.3, not on 100.
    const trueBpm = 100.3
    const period = (60 / trueBpm) * FPS
    const onsets = new Float32Array(60000)
    for (let k = 0; Math.round(k * period) < 60000; k++) onsets[Math.round(k * period)] = 1
    const result = estimateBeatGrid(onsets, FPS, { hintBpm: 100 })
    expect(Math.abs(result!.grid.bpm - trueBpm)).toBeLessThan(0.05)
    expect(result!.confident).toBe(true)
  })

  it('recovers a known phase offset to within one frame', () => {
    const bpm = 128
    const lag = Math.round((60 / bpm) * FPS)
    const phaseFrames = 37
    const onsets = clickTrack(lag, 2000, phaseFrames)
    const result = estimateBeatGrid(onsets, FPS)
    expect(result).not.toBeNull()
    expect(result!.grid.offsetSec).toBeCloseTo(phaseFrames / FPS, 3)
  })

  it('flags a flat, non-periodic envelope as unconfident instead of guessing silently', () => {
    // All-zero envelope: every candidate scores identically. Picking the first
    // one anyway and calling it a beat grid is exactly the silent-wrong-answer
    // this project's "never skip silently" rule forbids.
    const onsets = new Float32Array(2000)
    const result = estimateBeatGrid(onsets, FPS)
    expect(result).not.toBeNull()
    expect(result!.confident).toBe(false)
  })

  it('returns null for too little envelope to say anything', () => {
    // Mirrors detectBpm's old `env.length < 64` guard.
    expect(estimateBeatGrid(new Float32Array(63), FPS)).toBeNull()
  })
})

describe('quantizeToGrid', () => {
  const grid: BeatGrid = { bpm: 120, offsetSec: 0 } // beatSec = 0.5

  it('is the identity on an exact beat', () => {
    expect(quantizeToGrid(1.5, grid)).toBeCloseTo(1.5, 9)
  })

  it('snaps to the nearer beat when off-grid', () => {
    expect(quantizeToGrid(1.6, grid)).toBeCloseTo(1.5, 9)
    expect(quantizeToGrid(1.9, grid)).toBeCloseTo(2.0, 9)
  })

  it('rounds the exact half-beat boundary to one consistent side', () => {
    // Math.round rounds .5 toward +Infinity — asserted, not left to chance.
    expect(quantizeToGrid(1.75, grid)).toBeCloseTo(2.0, 9)
  })

  it('respects a non-zero offset', () => {
    const g: BeatGrid = { bpm: 120, offsetSec: 0.1 }
    expect(quantizeToGrid(0.1 + 0.5 * 5, g)).toBeCloseTo(0.1 + 2.5, 9)
  })
})

describe('phaseDeltaSec', () => {
  const grid: BeatGrid = { bpm: 120, offsetSec: 0 } // beatSec = 0.5

  it('is zero when both decks are already phase-aligned', () => {
    expect(phaseDeltaSec(10.0, grid, 20.5, grid)).toBeCloseTo(0, 9)
  })

  it('is positive when the deck is behind the master (needs to advance)', () => {
    expect(phaseDeltaSec(0.1, grid, 0.3, grid)).toBeCloseTo(0.2, 9)
  })

  it('is negative when the deck is ahead of the master (needs to retreat)', () => {
    expect(phaseDeltaSec(0.3, grid, 0.1, grid)).toBeCloseTo(-0.2, 9)
  })

  it('resolves the exact half-beat boundary to one consistent side', () => {
    expect(phaseDeltaSec(0.0, grid, 0.25, grid)).toBeCloseTo(-0.25, 9)
  })

  it('is robust to the two decks having slightly different detected bpm', () => {
    // The real reason this loop has to keep running: 0.1 bpm of detection
    // error between two decks is a real, expected gap, not a bug.
    const deckGrid: BeatGrid = { bpm: 120, offsetSec: 0 }
    const masterGrid: BeatGrid = { bpm: 120.1, offsetSec: 0 }
    const delta = phaseDeltaSec(10.0, deckGrid, 10.0, masterGrid)
    expect(Math.abs(delta)).toBeGreaterThan(0)
    expect(Math.abs(delta)).toBeLessThan(0.01)
  })
})

describe('halveGrid / doubleGrid', () => {
  it('halves bpm and keeps offset (the period only grows)', () => {
    const g: BeatGrid = { bpm: 128, offsetSec: 0.12 }
    expect(halveGrid(g)).toEqual({ bpm: 64, offsetSec: 0.12 })
  })

  it('doubles bpm and folds offset into the new, shorter bar', () => {
    const g: BeatGrid = { bpm: 64, offsetSec: 2.7 }
    const doubled = doubleGrid(g)
    const newBarSec = (60 / 128) * 4
    expect(doubled.bpm).toBe(128)
    expect(doubled.offsetSec).toBeGreaterThanOrEqual(0)
    expect(doubled.offsetSec).toBeLessThan(newBarSec)
    expect(doubled.offsetSec).toBeCloseTo(2.7 % newBarSec, 9)
  })

  it('keeps which beat is the "1" when doubling (v0.8.23)', () => {
    // 1.2s at 128 bpm is beat 2.56 of the first bar — folding into a beat
    // (0.46875s) threw that away and moved the yellow line to 0.2625s.
    expect(doubleGrid({ bpm: 64, offsetSec: 1.2 }).offsetSec).toBeCloseTo(1.2, 9)
  })
})

describe('shiftGrid', () => {
  const g: BeatGrid = { bpm: 120, offsetSec: 0.1 } // beatSec = 0.5, barSec = 2

  it('shifts forward within one beat', () => {
    expect(shiftGrid(g, 0.05).offsetSec).toBeCloseTo(0.15, 9)
  })

  it('does not wrap a nudge that crosses a beat inside the bar (v0.8.23)', () => {
    // Folding into a beat turned this into 0.05 — the bar line jumped a beat back.
    expect(shiftGrid(g, 0.45).offsetSec).toBeCloseTo(0.55, 9)
  })

  it('wraps a forward shift past the bar period', () => {
    expect(shiftGrid(g, 1.95).offsetSec).toBeCloseTo(0.05, 9)
  })

  it('wraps a backward shift past zero into the last beat of the bar', () => {
    expect(shiftGrid(g, -0.2).offsetSec).toBeCloseTo(1.9, 9)
  })

  it('keeps a bar line on beat 3 where it is when nudged (v0.8.23)', () => {
    const onBeat3: BeatGrid = { bpm: 120, offsetSec: 1.0 }
    expect(shiftGrid(onBeat3, 0.01).offsetSec).toBeCloseTo(1.01, 9)
  })
})

describe('setDownbeatAt', () => {
  it('folds a mark inside the first beat unchanged', () => {
    expect(setDownbeatAt(120, 0.2)).toEqual({ bpm: 120, offsetSec: 0.2 })
  })

  it('folds a mark past several bars down to its place in the bar', () => {
    const g = setDownbeatAt(120, 4.3) // barSec 2: 4.3 = 2*2 + 0.3
    expect(g.bpm).toBe(120)
    expect(g.offsetSec).toBeCloseTo(0.3, 9)
  })

  it('a mark on beat 3 puts the yellow line on beat 3, not beat 1 (v0.8.23)', () => {
    // The owner's bug of 24/09: beat 3 of bar 2 at 120 bpm is 3.0s. Folding
    // into a beat gave 0 — the line stayed on beat 1.
    const g = setDownbeatAt(120, 3.0)
    expect(g.offsetSec).toBeCloseTo(1.0, 9)
    expect(nextBarLineSec(2.9, g)).toBeCloseTo(3.0, 9)
  })
})

describe('bpmFromTaps', () => {
  it('recovers bpm from a clean, evenly spaced tap sequence', () => {
    const taps = [0, 0.5, 1.0, 1.5, 2.0] // 120 bpm
    expect(bpmFromTaps(taps)).toBeCloseTo(120, 1)
  })

  it('returns null with fewer than two taps', () => {
    expect(bpmFromTaps([])).toBeNull()
    expect(bpmFromTaps([1.0])).toBeNull()
  })

  it('recovers close to the true tempo despite one fat-fingered interval', () => {
    const taps = [0, 0.5, 1.0, 1.9, 2.4] // one interval is 0.9s instead of 0.5s
    const bpm = bpmFromTaps(taps)
    expect(bpm).not.toBeNull()
    expect(Math.abs(bpm! - 120)).toBeLessThan(5)
  })
})

describe('nextBarLineSec', () => {
  const grid = { bpm: 120, offsetSec: 0.3 } // bar 2.0s → lines at 0.3, 2.3, 4.3 …

  it('returns the next yellow line strictly ahead', () => {
    expect(nextBarLineSec(1.0, grid)).toBeCloseTo(2.3, 10)
    expect(nextBarLineSec(2.29, grid)).toBeCloseTo(2.3, 10)
  })

  it('sitting exactly on a line waits for the next one, not the one already passed', () => {
    expect(nextBarLineSec(2.3, grid)).toBeCloseTo(4.3, 10)
  })

  it('before the grid offset, the first line is the offset itself', () => {
    expect(nextBarLineSec(0, grid)).toBeCloseTo(0.3, 10)
  })
})

// v0.8.14 review: a looping deck used to wait for "the next bar line" forever.
describe('barLineCrossed', () => {
  const grid = { bpm: 120, offsetSec: 0 } // bar lines at 0, 2, 4 …

  it('moving forward across a line counts, short of it does not', () => {
    expect(barLineCrossed(1.98, 2.01, grid)).toBe(true)
    expect(barLineCrossed(1.9, 1.98, grid)).toBe(false)
  })

  it('a 4-beat loop starting on a yellow line wraps back onto it — counts as crossing', () => {
    // loop 2.0–4.0: the frame before the wrap is at 3.99, the next at 2.006
    expect(barLineCrossed(3.99, 2.006, grid)).toBe(true)
  })

  it('a short loop with no yellow line inside never counts', () => {
    // loop 2.5–3.5, wrapping 3.49 → 2.51
    expect(barLineCrossed(3.49, 2.51, grid)).toBe(false)
  })
})
