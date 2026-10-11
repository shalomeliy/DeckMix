import { describe, expect, it } from 'vitest'
import {
  addSampleRegion,
  contourCorrelation,
  createBandFrames,
  fillBandFrames,
  overlapsMark,
  rankCandidates,
  removeLastSample,
  sampleMarksExportText,
} from '@/core/sound/sample-marks'

const SR = 22050
const BPM = 120
const BEAT = 60 / BPM
const BAR = BEAT * 4
const GRID = { bpm: BPM, offsetSec: 0 }

/** 16 bars: a steady kick + hat pattern, a bass note that changes after bar 8 (the repeating part is bars 0–7). */
function track(bassAfter8: number): Float32Array {
  const x = new Float32Array(Math.floor(16 * BAR * SR))
  for (let bar = 0; bar < 16; bar++) {
    const bassHz = bar < 8 ? 55 : bassAfter8
    for (let n = 0; n < 16; n++) {
      const t0 = bar * BAR + n * (BAR / 16)
      const i0 = Math.floor(t0 * SR)
      const len = Math.floor((BAR / 16) * SR)
      if (n % 4 === 0) for (let i = 0; i < len; i++) x[i0 + i] += 0.6 * Math.sin(2 * Math.PI * 60 * (i / SR)) * Math.exp(-i / (0.06 * SR))
      if (n % 2 === 1) for (let i = 0; i < len; i++) x[i0 + i] += 0.2 * (Math.sin(i * 12.9898) * 43758.5453 % 1) * Math.exp(-i / (0.02 * SR))
      if (n < 8 || bar < 8) for (let i = 0; i < len; i++) x[i0 + i] += 0.3 * Math.sin(2 * Math.PI * bassHz * (i / SR))
    }
  }
  return x
}

function frames(x: Float32Array) {
  const f = createBandFrames(x.length, SR)
  fillBandFrames(x, f, 0, f.frames)
  return f
}

describe('rankCandidates', () => {
  it('puts the repeating part first and the part before a change below it', () => {
    const f = frames(track(98))
    const c = rankCandidates(f, GRID, 16 * BAR, 4, 20)
    const at = (from: number) => c.find((x) => Math.abs(x.fromSec - from * BAR) < 1e-6)
    expect(at(0)!.score).toBeGreaterThan(0.9)
    // bars 4–7 are followed by a block whose bass note is different
    expect(at(4)!.score).toBeLessThan(at(0)!.score - 0.05)
  })
  it('returns nothing without a usable grid, and never a window without a whole next block', () => {
    const f = frames(track(98))
    expect(rankCandidates(f, null, 16 * BAR, 4)).toEqual([])
    expect(rankCandidates(f, GRID, 16 * BAR, 4, 99).every((c) => c.toSec + 4 * BAR <= 16 * BAR + 1e-6)).toBe(true)
  })
  it('picks windows that do not overlap each other', () => {
    const c = rankCandidates(frames(track(98)), GRID, 16 * BAR, 4, 6)
    for (let i = 1; i < c.length; i++) expect(c[i].fromSec).toBeGreaterThanOrEqual(c[i - 1].toSec - 1e-6)
  })
})

describe('contourCorrelation', () => {
  it('is 1 for the same contour and 0 for a flat one', () => {
    const a = Float64Array.from({ length: 26 }, (_, i) => Math.sin(i))
    expect(contourCorrelation(a, a)).toBeCloseTo(1, 6)
    expect(contourCorrelation(a, new Float64Array(26))).toBe(0)
  })
})

describe('addSampleRegion', () => {
  it('snaps a loop out to the yellow lines and keeps a hit exactly', () => {
    const loop = addSampleRegion([], 'loop', 2.3, 9.1, 60, GRID)
    expect(loop.ok && loop.regions[0]).toEqual({ fromSec: 2, toSec: 10, kind: 'loop' })
    const hit = addSampleRegion([], 'hit', 2.3, 2.9, 60, GRID)
    expect(hit.ok && hit.regions[0]).toEqual({ fromSec: 2.3, toSec: 2.9, kind: 'hit' })
  })
  it('refuses presses that are too close, before snapping them out to a whole bar', () => {
    expect(addSampleRegion([], 'loop', 2.3, 2.5, 60, GRID)).toEqual({ ok: false, reason: 'too-short' })
    expect(addSampleRegion([], 'hit', 1, 1.05, 60, GRID)).toEqual({ ok: false, reason: 'too-short' })
    expect(addSampleRegion([], 'loop', NaN, 3, 60, GRID)).toEqual({ ok: false, reason: 'bad-time' })
  })
  it('keeps the presses of a loop when the song has no grid, and undo removes the last mark only', () => {
    const a = addSampleRegion([], 'loop', 3, 7, 60, null)
    expect(a.ok && a.regions[0]).toEqual({ fromSec: 3, toSec: 7, kind: 'loop' })
    const b = addSampleRegion(a.ok ? a.regions : [], 'hit', 9, 9.5, 60, null)
    expect(removeLastSample(b.ok ? b.regions : [])).toHaveLength(1)
  })
})

describe('overlapsMark and the file', () => {
  it('counts a candidate that covers half of a mark', () => {
    const marks = [{ fromSec: 8, toSec: 16, kind: 'loop' as const }]
    expect(overlapsMark({ fromSec: 8, toSec: 12 }, marks)).toBe(true)
    expect(overlapsMark({ fromSec: 20, toSec: 24 }, marks)).toBe(false)
  })
  it('writes the kind, so a later reader can tell the file apart', () => {
    expect(JSON.parse(sampleMarksExportText([], 1)).kind).toBe('sample-marks')
  })
})
