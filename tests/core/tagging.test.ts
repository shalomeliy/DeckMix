import { describe, expect, it } from 'vitest'
import {
  BAR_PER_GENRE,
  HOLDOUT_PER_GENRE,
  MARK_SCHEMA,
  markBeatOf,
  snapToBeat,
  startGrid,
  startMarkSec,
  tagsExportText,
  VOCAL_CLIP_SEC,
  dropSpots,
  gridWithOneOn,
  pickBarSample,
  pickVocalSample,
  vocalSpotSec,
} from '@/core/tagging'

const lib = (counts: Record<string, number>) =>
  Object.entries(counts).flatMap(([g, n]) => Array.from({ length: n }, (_, i) => ({ id: `${g}/${i}.mp3`, genre: g })))

describe('pickBarSample', () => {
  const tracks = [...lib({ House: 80, Techno: 60, Trance: 40, HipHop: 30, Mizrahi: 25, Final: 3 }), { id: 'loose.mp3' }]
  const sample = pickBarSample(tracks)

  it('takes the five biggest genres, 24 each, and leaves out tracks with no genre', () => {
    const genres = new Set(sample.map((s) => s.genre))
    expect([...genres].sort()).toEqual(['HipHop', 'House', 'Mizrahi', 'Techno', 'Trance'])
    for (const g of genres) expect(sample.filter((s) => s.genre === g)).toHaveLength(BAR_PER_GENRE)
    expect(sample.some((s) => s.trackId === 'loose.mp3')).toBe(false)
  })
  it('seals 6 per genre as the final test', () => {
    for (const g of new Set(sample.map((s) => s.genre)))
      expect(sample.filter((s) => s.genre === g && s.holdout)).toHaveLength(HOLDOUT_PER_GENRE)
  })
  it('is the same sample every time, whatever order the scan listed the files in', () => {
    expect(pickBarSample([...tracks].reverse())).toEqual(sample)
  })
  it('interleaves genres, so stopping after 10 still covers all five', () => {
    expect(new Set(sample.slice(0, 10).map((s) => s.genre)).size).toBe(5)
  })
  it('a small genre gives what it has', () => {
    const small = pickBarSample(lib({ A: 30, B: 5 }))
    expect(small.filter((s) => s.genre === 'B')).toHaveLength(5)
  })
})

describe('pickVocalSample', () => {
  it('does not overlap the sealed bar test set', () => {
    const tracks = lib({ House: 80, Techno: 60, Trance: 40, HipHop: 30, Mizrahi: 25 })
    const sealed = new Set(pickBarSample(tracks).filter((s) => s.holdout).map((s) => s.trackId))
    const vocal = pickVocalSample(tracks)
    expect(vocal).toHaveLength(30)
    expect(vocal.some((v) => sealed.has(v.trackId))).toBe(false)
    expect(vocal.filter((v) => v.holdout)).toHaveLength(10)
  })
})

describe('dropSpots', () => {
  const grid = { bpm: 120, offsetSec: 0.25 } // bar = 2 s
  it('puts the loop two bars before the biggest jump in energy', () => {
    // 100 s, 1 value per second: quiet, then loud from 40 s (bar 20 starts at 40.25)
    const energy = Array.from({ length: 100 }, (_, s) => (s >= 41 ? 1 : 0.1))
    const [first] = dropSpots(energy, 100, grid, 1)
    expect(first).toBeCloseTo(0.25 + 18 * 2)
  })
  it('spots are at least 8 bars apart, and all on bar lines', () => {
    const energy = Array.from({ length: 200 }, (_, s) => (Math.floor(s / 20) % 2 ? 1 : 0.1))
    const spots = dropSpots(energy, 200, grid, 3)
    expect(spots.length).toBeGreaterThan(1)
    for (const a of spots) {
      expect(((a - 0.25) / 2) % 1).toBeCloseTo(0)
      for (const b of spots) if (a !== b) expect(Math.abs(a - b)).toBeGreaterThanOrEqual(16)
    }
  })
  it('flat energy gives the first bar line, not nothing', () => {
    expect(dropSpots(new Array(50).fill(0.5), 50, grid)).toEqual([0.25])
  })
})

describe('gridWithOneOn', () => {
  it('beat 0 keeps the grid; beat 2 moves the "1" two beats later', () => {
    const g = { bpm: 120, offsetSec: 0.1 }
    expect(gridWithOneOn(g, 0).offsetSec).toBeCloseTo(0.1)
    expect(gridWithOneOn(g, 2).offsetSec).toBeCloseTo(1.1)
  })
  it('stays inside the first bar', () => {
    expect(gridWithOneOn({ bpm: 120, offsetSec: 1.9 }, 3).offsetSec).toBeCloseTo(1.4)
  })
})

describe('vocalSpotSec', () => {
  it('lands away from intro and outro, and the whole clip fits', () => {
    for (const id of ['a', 'b', 'House/3.mp3', 'x/y/z.flac']) {
      const at = vocalSpotSec(id, 240)
      expect(at).toBeGreaterThanOrEqual(36)
      expect(at + VOCAL_CLIP_SEC).toBeLessThanOrEqual(204 + 1e-9)
      expect(vocalSpotSec(id, 240)).toBe(at)
    }
  })
})

describe('v0.9.1 waveform marker', () => {
  const g = { bpm: 120, offsetSec: 0.3 } // beat = 0.5 s, bar = 2 s

  it('snapToBeat: a press lands on the nearest beat, either side', () => {
    expect(snapToBeat(10.52, g)).toBeCloseTo(10.3)
    expect(snapToBeat(10.56, g)).toBeCloseTo(10.8)
    expect(snapToBeat(0.1, g)).toBeCloseTo(0.3)
  })

  it('snapToBeat keeps a fine shift: snapping on a grid through the marker never undoes it', () => {
    const mark = 20.3 + 0.01
    expect(snapToBeat(21.2, { bpm: 120, offsetSec: mark })).toBeCloseTo(21.31)
  })

  it('startMarkSec: the bar line the jump lands on, two bars after the spot', () => {
    expect(startMarkSec(4.3, g)).toBeCloseTo(8.3)
  })

  it('startGrid: the detector, unless the owner changed the tempo', () => {
    const det = { bpm: 120, offsetSec: 0.3 }
    // A phase-only correction is ignored — v0.9.0's first answers moved three bar lines to wrong places.
    expect(startGrid(det, { bpm: 120, offsetSec: 1.1 })).toBe(det)
    const halved = { bpm: 60, offsetSec: 0.3 }
    expect(startGrid(det, halved)).toBe(halved)
    expect(startGrid(null, halved)).toBe(halved)
    expect(startGrid(null, null)).toBe(null)
  })

  it('markBeatOf: which beat of a bar the mark is on, and by how much it misses', () => {
    expect(markBeatOf(8.3, g)).toEqual({ beat: 0, errSec: expect.closeTo(0, 6) })
    const r = markBeatOf(9.32, g)
    expect(r.beat).toBe(2)
    expect(r.errSec).toBeCloseTo(0.02)
    expect(markBeatOf(-0.2, g).beat).toBe(3)
  })

  it('export keeps the old 4-button answers under their old name, beside the new ones', () => {
    const out = JSON.parse(tagsExportText([], [], [], 1))
    expect(out.schema).toBe(MARK_SCHEMA)
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['bar', 'mark', 'vocal']))
  })
})
