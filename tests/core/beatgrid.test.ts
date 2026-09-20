import { describe, expect, it } from 'vitest'
import {
  bpmFromTaps,
  doubleGrid,
  estimateBeatGrid,
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

  it('doubles bpm and folds offset into the new, shorter beat', () => {
    const g: BeatGrid = { bpm: 64, offsetSec: 0.7 }
    const doubled = doubleGrid(g)
    const newBeatSec = 60 / 128
    expect(doubled.bpm).toBe(128)
    expect(doubled.offsetSec).toBeGreaterThanOrEqual(0)
    expect(doubled.offsetSec).toBeLessThan(newBeatSec)
    expect(doubled.offsetSec).toBeCloseTo(0.7 % newBeatSec, 9)
  })
})

describe('shiftGrid', () => {
  const g: BeatGrid = { bpm: 120, offsetSec: 0.1 } // beatSec = 0.5

  it('shifts forward within one beat', () => {
    expect(shiftGrid(g, 0.05).offsetSec).toBeCloseTo(0.15, 9)
  })

  it('wraps a forward shift past the beat period', () => {
    expect(shiftGrid(g, 0.45).offsetSec).toBeCloseTo(0.05, 9)
  })

  it('wraps a backward shift past zero', () => {
    expect(shiftGrid(g, -0.2).offsetSec).toBeCloseTo(0.4, 9)
  })

  it('wraps a shift larger than a full beat period', () => {
    expect(shiftGrid(g, 1.05).offsetSec).toBeCloseTo(0.15, 9)
  })
})

describe('setDownbeatAt', () => {
  it('folds a mark inside the first beat unchanged', () => {
    expect(setDownbeatAt(120, 0.2)).toEqual({ bpm: 120, offsetSec: 0.2 })
  })

  it('folds a mark past several beats down to its phase', () => {
    const g = setDownbeatAt(120, 2.3) // beatSec 0.5: 2.3 = 4*0.5 + 0.3
    expect(g.bpm).toBe(120)
    expect(g.offsetSec).toBeCloseTo(0.3, 9)
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
