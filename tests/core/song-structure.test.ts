import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '@/core/settings'
import {
  STRUCTURE_TARGET,
  inStructureGenre,
  scoreStructure,
  singingSpan,
  snapToBar,
  structureHint,
  structureHintV2,
  structureMarksExportText,
  structureQueueOrder,
  type StructureMark,
} from '@/core/song-structure'

const grid = { bpm: 120, offsetSec: 0.5 } // bar = 2 s

/** `bands` with a given bass level per second (interleaved low/mid/high, 10 buckets a second). */
function bandsFrom(levelPerSec: (sec: number) => number, durationSec: number): Float32Array {
  const perSec = 10
  const b = new Float32Array(durationSec * perSec * 3)
  for (let i = 0; i < durationSec * perSec; i++) {
    b[i * 3] = levelPerSec(i / perSec)
    b[i * 3 + 1] = 0.1
    b[i * 3 + 2] = 0.1
  }
  return b
}

describe('structureQueueOrder', () => {
  const t = (id: string, genre: string | undefined, contentHash?: string) => ({ id, genre, contentHash })
  it('keeps only Techno, House and Mizrahi with a checked "1" and no mark yet (Hip Hop and Trance out, 22/10)', () => {
    const tracks = [t('1', 'Techno', 'a'), t('2', 'Hip Hop', 'b'), t('3', 'Trance', 'c'), t('4', 'House', 'd'), t('5', 'Mizrahi', 'e'), t('6', 'Techno', 'f'), t('7', 'Techno', 'g'), t('8', undefined, 'h'), t('9', 'Techno')]
    const checked = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'h'])
    const marked = new Set(['f'])
    expect(structureQueueOrder(tracks, checked, marked).map((x) => x.id)).toEqual(['1', '5', '4']) // House last since 25/10
  })
})

describe('inStructureGenre', () => {
  it('his exclusion wins over a name that also says House', () => {
    expect(inStructureGenre('Tech House')).toBe(true)
    expect(inStructureGenre('Hip House')).toBe(false)
    expect(inStructureGenre('Trance')).toBe(false)
    expect(inStructureGenre(undefined)).toBe(false)
  })
})

describe('snapToBar', () => {
  it('a press 200 ms late lands on the bar line it meant', () => {
    expect(snapToBar(32.5 + 0.2, grid)).toBeCloseTo(32.5, 9)
  })
  it('never before the start of the song', () => {
    expect(snapToBar(0.1, { bpm: 120, offsetSec: 1.9 })).toBeGreaterThanOrEqual(0)
  })
})

describe('structureHint', () => {
  it('finds the bar where the full bass comes in and the bar where it ends', () => {
    // quiet intro to 32.5 s (16 bars), full to 160.5 s, quiet after: the song is 200 s.
    const b = bandsFrom((s) => (s >= 32.5 && s < 160.5 ? 1 : 0.1), 200)
    const h = structureHint(b, 200, grid)
    expect(h.introEndSec).toBeCloseTo(32.5, 6)
    expect(h.outroStartSec).toBeCloseTo(160.5, 6)
  })
  it('says none (null) when the full beat runs from the first bar to the last, instead of inventing a point', () => {
    const b = bandsFrom(() => 1, 200)
    expect(structureHint(b, 200, grid)).toEqual({ introEndSec: null, outroStartSec: null })
  })
  it('one loud kick inside the intro is not the drop', () => {
    const b = bandsFrom((s) => (s >= 10.5 && s < 12.5) || (s >= 32.5 && s < 160.5) ? 1 : 0.1, 200)
    expect(structureHint(b, 200, grid).introEndSec).toBeNull() // a full bar before the drop: not a clean intro, so no guess
  })
  it('empty bands give no guess', () => {
    expect(structureHint(new Float32Array(0), 200, grid)).toEqual({ introEndSec: null, outroStartSec: null })
  })
})

/** `bands` with separate bass and mid+high levels per second. */
function bandsSplit(low: (sec: number) => number, top: (sec: number) => number, durationSec: number): Float32Array {
  const perSec = 10
  const b = new Float32Array(durationSec * perSec * 3)
  for (let i = 0; i < durationSec * perSec; i++) {
    b[i * 3] = low(i / perSec)
    b[i * 3 + 1] = top(i / perSec)
    b[i * 3 + 2] = top(i / perSec)
  }
  return b
}

describe('structureHintV2', () => {
  // bar = 2 s from 0.5 s: bar 8 = 16.5 s, bar 16 = 32.5 s, bar 80 = 160.5 s. Song 200 s.
  it('his House case: the bass comes in at bar 8 but the drop is at 16, and the bass runs on through the outro', () => {
    const b = bandsSplit((s) => (s >= 16.5 ? 1 : 0.1), (s) => (s >= 32.5 && s < 160.5 ? 1 : 0.3), 200)
    const h = structureHintV2(b, 200, grid)
    expect(h.introEndSec).toBeCloseTo(32.5, 6) // the first guess said bar 8 here
    expect(h.outroStartSec).toBeCloseTo(160.5, 6) // the first guess, watching the bass, found no outro at all
  })
  it('only phrase lines are candidates: a rise on bar 12 is on no intro line, so no intro is guessed (both sides of 16 are loud)', () => {
    const b = bandsSplit(() => 1, (s) => (s >= 24.5 ? 1 : 0.3), 200)
    expect(structureHintV2(b, 200, grid).introEndSec).toBeNull()
  })
  it('an outro on a 4-bar line that is not an 8-bar one is still found', () => {
    // drop at bar 76 (152.5 s): his outro marks sat on a 4-bar line 17 of 22 times, on an 8-bar one 9 times
    const b = bandsSplit(() => 1, (s) => (s >= 32.5 && s < 152.5 ? 1 : 0.3), 200)
    expect(structureHintV2(b, 200, grid).outroStartSec).toBeCloseTo(152.5, 6)
  })
  it('a flat song gets no guess on either side', () => {
    const b = bandsSplit(() => 1, () => 1, 200)
    expect(structureHintV2(b, 200, grid)).toEqual({ introEndSec: null, outroStartSec: null })
  })
  it('the outro is never looked for in the first 55% of the song', () => {
    const b = bandsSplit(() => 1, (s) => (s >= 32.5 && s < 64.5 ? 1 : 0.3), 200)
    const o = structureHintV2(b, 200, grid).outroStartSec
    expect(o == null || o >= 110).toBe(true)
  })
})

describe('scoreStructure', () => {
  const mark = (own: [number | null, number | null], guess: [number | null, number | null], i = 0): StructureMark => ({
    schema: 1,
    contentHash: `h${i}`,
    trackId: `t${i}`,
    name: `s${i}`,
    introEndSec: own[0],
    outroStartSec: own[1],
    hint: { introEndSec: guess[0], outroStartSec: guess[1] },
    barSec: 2,
    updatedAt: 0,
  })
  it('a guess within one bar is a hit, two bars off is a miss, and both saying "none" is a hit', () => {
    const s = scoreStructure([mark([32, 160], [34, 164]), mark([null, null], [null, 100], 1)])
    expect(s.intro).toEqual({ answered: 2, hit: 2 })
    expect(s.outro).toEqual({ answered: 2, hit: 0 })
    expect(s.passed).toBeNull() // fewer than the 20 songs the rule needs: no verdict yet
  })
  it('passes at 70% over 20 songs and fails below', () => {
    const good = Array.from({ length: STRUCTURE_TARGET }, (_, i) => mark([32, 160], i < 14 ? [32, 160] : [50, 100], i))
    expect(scoreStructure(good).passed).toBe(true)
    const bad = Array.from({ length: STRUCTURE_TARGET }, (_, i) => mark([32, 160], i < 13 ? [32, 160] : [50, 100], i))
    expect(scoreStructure(bad).passed).toBe(false)
  })
  it('the export carries the marks, the guesses and the score; only marks under the second guess count in `score`', () => {
    const first = mark([32, 160], [32, 160])
    const second = { ...mark([32, 160], [50, 160], 1), hintVersion: 2 as const }
    const j = JSON.parse(structureMarksExportText([first, second], 5))
    expect(j.kind).toBe('structure-marks')
    expect(j.marks[0].hint.introEndSec).toBe(32)
    expect(j.score.intro).toEqual({ answered: 1, hit: 0 })
    expect(j.score.outro).toEqual({ answered: 1, hit: 1 })
    expect(j.firstRoundScore.intro).toEqual({ answered: 1, hit: 1 })
  })
})

describe('setting', () => {
  it('is off by default: an experiment he turns on', () => {
    expect(DEFAULTS.structureMarking).toBe(false)
  })
})

describe('singingSpan (v0.9.40b, the "On the singing" shortcut)', () => {
  const tag = (regions: { fromSec: number; toSec: number; kind?: 'none' }[], finished = true) => ({ regions, finished })

  it('gives the first singing start and the last singing end, on the nearest bar line of the grid', () => {
    // bar lines at 0.5, 2.5, 4.5 ... ; singing 16.4-40.6 and 60.5-90.3
    expect(singingSpan(tag([{ fromSec: 16.4, toSec: 40.6 }, { fromSec: 60.5, toSec: 90.3 }]), 200, grid)).toEqual({ startSec: 16.5, endSec: 90.5 })
  })

  it('a "no singing" region painted over the start wins, as on his strip', () => {
    expect(singingSpan(tag([{ fromSec: 10.5, toSec: 40.5 }, { fromSec: 10.5, toSec: 20.5, kind: 'none' }]), 200, grid)).toEqual({ startSec: 20.5, endSec: 40.5 })
  })

  it('an unfinished song gives nothing: the stretch he never listened to could hold the first singing', () => {
    expect(singingSpan(tag([{ fromSec: 16.5, toSec: 40.5 }], false), 200, grid)).toBeNull()
  })

  it('singing from the first bar or to the very end leaves that side empty: it is "No intro" / "No outro", not a line', () => {
    expect(singingSpan(tag([{ fromSec: 0, toSec: 40.5 }]), 200, grid)).toEqual({ startSec: null, endSec: 40.5 })
    expect(singingSpan(tag([{ fromSec: 16.5, toSec: 200 }]), 200, grid)).toEqual({ startSec: 16.5, endSec: null })
    expect(singingSpan(tag([{ fromSec: 0, toSec: 200 }]), 200, grid)).toBeNull()
  })

  it('no marks, or a finished song with no singing at all, gives nothing', () => {
    expect(singingSpan(null, 200, grid)).toBeNull()
    expect(singingSpan(tag([]), 200, grid)).toBeNull()
    expect(singingSpan(tag([{ fromSec: 10.5, toSec: 40.5, kind: 'none' }]), 200, grid)).toBeNull()
  })
})
