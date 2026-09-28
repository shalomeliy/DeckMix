import { describe, expect, it } from 'vitest'
import {
  BAR_PER_GENRE,
  HOLDOUT_PER_GENRE,
  MARK_SCHEMA,
  DISPUTE_TOLERANCE_SEC,
  blindOffsetBeats,
  neutralSec,
  disputedSongs,
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

describe('v0.12.8 disputedSongs', () => {
  const grid = { bpm: 120, offsetSec: 0.3 } // beat 0.5 s
  const old = (hash: string, answer: 0 | 1 | 2 | 3 | 'skip', shown = grid) => ({
    schema: 1, contentHash: hash, trackId: `t/${hash}`, name: hash, genre: 'House', holdout: false,
    answer, detectorGrid: grid, shownGrid: shown, taggedAt: 1,
  })
  const mark = (hash: string, markSec: number, bpm = 120) => ({
    schema: 2, contentHash: hash, trackId: `t/${hash}`, name: hash, genre: 'House', holdout: hash === 'b',
    answer: 'marked' as const, markSec, bpm, startMarkSec: markSec, moved: false, answerMs: 1, plays: 1,
    detectorGrid: grid, shownGrid: grid, replacedCorrection: null, taggedAt: 2,
  })

  it('same "1" in both rounds is not disputed, even bars apart', () => {
    // old: beat 2 of the shown grid → the "1" at 1.3 s; new: 9.3 s, four bars later
    expect(disputedSongs([old('a', 2)], [mark('a', 9.3)])).toEqual([])
  })

  it('a different beat as the "1" is disputed, and carries the row it was sampled as', () => {
    expect(disputedSongs([old('a', 0), old('b', 1)], [mark('a', 8.8), mark('b', 8.8)])).toEqual([
      { trackId: 't/a', genre: 'House', holdout: false },
    ])
  })

  it('a different tempo is disputed; a skipped old answer or no old answer is not', () => {
    expect(disputedSongs([old('a', 0, { bpm: 60, offsetSec: 0.3 })], [mark('a', 8.3)]).length).toBe(1)
    expect(disputedSongs([old('a', 'skip')], [mark('a', 8.3)])).toEqual([])
    expect(disputedSongs([], [mark('a', 8.3)])).toEqual([])
  })

  it('a few ms apart is the same answer', () => {
    expect(disputedSongs([old('a', 0)], [mark('a', 8.3 + DISPUTE_TOLERANCE_SEC / 2)])).toEqual([])
  })
})

describe('v0.12.8 review fixes', () => {
  it('blindOffsetBeats spreads songs over all four beats, the same every time', () => {
    const counts = [0, 0, 0, 0]
    for (let i = 0; i < 400; i++) counts[blindOffsetBeats(`House/${i}.mp3`)]++
    for (const c of counts) expect(c).toBeGreaterThan(60)
    expect(blindOffsetBeats('a.mp3')).toBe(blindOffsetBeats('a.mp3'))
  })

  it('a tempo a hair apart, late in the song, is still the same answer', () => {
    const g = { bpm: 128, offsetSec: 0.2 }
    const old = { schema: 1, contentHash: 'x', trackId: 't/x', name: 'x', genre: 'House', holdout: false, answer: 0 as const, detectorGrid: g, shownGrid: g, taggedAt: 1 }
    const bpm = 128.04 // 0.04 apart: under the tempo line, but 300 s drifts ~0.09 s
    const markSec = 0.2 + Math.round((300 - 0.2) / (60 / bpm)) * (60 / bpm)
    const m = { schema: 2, contentHash: 'x', trackId: 't/x', name: 'x', genre: 'House', holdout: false, answer: 'marked' as const, markSec, bpm, startMarkSec: markSec, moved: false, answerMs: 1, plays: 1, detectorGrid: g, shownGrid: g, replacedCorrection: null, taggedAt: 2 }
    // Only a whole-bar multiple of the new beat keeps it on the old "1"; pick one.
    const bars = Math.round((markSec - 0.2) / ((4 * 60) / bpm))
    const onBar = 0.2 + bars * ((4 * 60) / bpm)
    expect(disputedSongs([old], [{ ...m, markSec: onBar }])).toEqual([])
  })

  it('a real tempo difference is flagged as one', () => {
    const g = { bpm: 128, offsetSec: 0.2 }
    const old = { schema: 1, contentHash: 'x', trackId: 't/x', name: 'x', genre: 'House', holdout: false, answer: 0 as const, detectorGrid: g, shownGrid: g, taggedAt: 1 }
    const m = { schema: 2, contentHash: 'x', trackId: 't/x', name: 'x', genre: 'House', holdout: false, answer: 'marked' as const, markSec: 8.2, bpm: 64, startMarkSec: 8.2, moved: false, answerMs: 1, plays: 1, detectorGrid: g, shownGrid: g, replacedCorrection: null, taggedAt: 2 }
    expect(disputedSongs([old], [m])[0]?.tempoDiffers).toBe(true)
  })
})

describe('v0.12.8 neutralSec', () => {
  it('moves by the song\'s blind beats, and stays inside the song by whole beats', () => {
    const k = blindOffsetBeats('House/1.mp3')
    expect(neutralSec(10, 'House/1.mp3', 120, 100)).toBeCloseTo(10 + k * 0.5)
    const end = neutralSec(99.9, 'House/1.mp3', 120, 100)
    expect(end).toBeLessThanOrEqual(100)
    expect(((end - 99.9) / 0.5) % 1).toBeCloseTo(0)
  })
})
