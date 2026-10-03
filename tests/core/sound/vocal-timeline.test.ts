import { describe, expect, it } from 'vitest'
import {
  CELL_NONE,
  CELL_UNSURE,
  CELL_VOCAL,
  COUNTDOWN_MERGE_GAP_SEC,
  dashedFraction,
  stateOfTimeline,
  vocalCountdown,
  vocalStateText,
  vocalStripSegments,
  type VocalTimeline,
} from '@/core/sound/vocal-timeline.ts'

const tl = (cells: number[], stereo = true): VocalTimeline => ({ cells: Uint8Array.from(cells), stereo })

describe('stateOfTimeline', () => {
  it('names the three finished outcomes', () => {
    expect(stateOfTimeline(tl([0, 1, 0]))).toBe('ready')
    expect(stateOfTimeline(tl([0, 2, 0]))).toBe('no-vocals')
    expect(stateOfTimeline(tl([0, 1, 0], false))).toBe('mono')
  })
})

describe('vocalStateText', () => {
  it('says every non-ready state in words, and nothing when ready', () => {
    expect(vocalStateText('ready')).toBeNull()
    expect(vocalStateText('ready', "ז'אנר לא מוכר")).toContain('לא מוכר') // a ready strip with a caveat says the caveat
    for (const s of ['queued', 'analysing', 'mono', 'no-vocals', 'too-short', 'silent', 'failed'] as const) {
      expect(vocalStateText(s, 'x')).toBeTruthy()
    }
    expect(vocalStateText('failed', 'decode error')).toContain('decode error')
  })
})

describe('vocalStripSegments', () => {
  it('merges runs and places them as a share of the track', () => {
    const segs = vocalStripSegments(tl([0, 0, 1, 1, 1, 0, 0, 0, 0, 0]), 5, 500)
    expect(segs.map((s) => s.cell)).toEqual([CELL_NONE, CELL_VOCAL, CELL_NONE])
    expect(segs[1].leftPct).toBeCloseTo(20)
    expect(segs[1].widthPct).toBeCloseTo(30)
  })
  it('never lets a short vocal vanish in a long track', () => {
    const cells = new Array(720).fill(0)
    cells[300] = 1 // half a second of vocal in a 6 minute track
    const segs = vocalStripSegments(tl(cells), 360, 400, 1)
    const v = segs.find((s) => s.cell === CELL_VOCAL)!
    expect((v.widthPct / 100) * 400).toBeGreaterThanOrEqual(1 - 1e-9)
  })
  it('keeps every box inside the strip, even at the very end', () => {
    const segs = vocalStripSegments(tl([0, 0, 0, 1]), 2, 100, 3)
    for (const s of segs) expect(s.leftPct + s.widthPct).toBeLessThanOrEqual(100 + 1e-9)
  })
  it('draws nothing without cells, a duration or a width', () => {
    expect(vocalStripSegments(tl([]), 10, 100)).toEqual([])
    expect(vocalStripSegments(tl([1]), 0, 100)).toEqual([])
    expect(vocalStripSegments(tl([1]), 10, 0)).toEqual([])
  })
  it('keeps unsure as its own segment, never merged into none', () => {
    const segs = vocalStripSegments(tl([0, 2, 2, 0]), 2, 100)
    expect(segs.map((s) => s.cell)).toEqual([CELL_NONE, CELL_UNSURE, CELL_NONE])
  })
})

describe('dashedFraction', () => {
  it('is the share of unsure cells', () => {
    expect(dashedFraction(tl([2, 0, 2, 1]))).toBeCloseTo(0.5)
    expect(dashedFraction(tl([]))).toBe(0)
  })
})

describe('vocalCountdown', () => {
  // one cell = 0.5 s. 0 none, 1 vocal, 2 unsure
  const tl = (s: string): VocalTimeline => ({ cells: Uint8Array.from([...s].map(Number)), stereo: true })
  const dur = 60
  it('before the voice: both timers count from the play position', () => {
    // 10 s of none (20 cells), 10 s of voice, 10 s of none
    const t = tl('0'.repeat(20) + '1'.repeat(20) + '0'.repeat(20))
    expect(vocalCountdown(t, 4, dur)).toEqual({ phase: 'before', startsInSec: 6, endsInSec: 16 })
  })
  it('inside the voice: it started "now" and the end counts down', () => {
    const t = tl('0'.repeat(20) + '1'.repeat(20) + '0'.repeat(20))
    expect(vocalCountdown(t, 15, dur)).toEqual({ phase: 'in', startsInSec: 0, endsInSec: 5 })
  })
  it('after the last voice there is nothing to count', () => {
    const t = tl('1'.repeat(10) + '0'.repeat(50))
    expect(vocalCountdown(t, 30, dur).phase).toBe('after')
  })
  it('a track with no voice anywhere says so', () => {
    expect(vocalCountdown(tl('0'.repeat(60)), 3, dur).phase).toBe('none')
  })
  it('unsure counts as voice: the timer never promises quiet over a dashed stretch', () => {
    const t = tl('0'.repeat(10) + '2'.repeat(10) + '0'.repeat(40))
    expect(vocalCountdown(t, 0, dur)).toEqual({ phase: 'before', startsInSec: 5, endsInSec: 10 })
  })
  it('a gap shorter than the merge threshold does not split the voice; a longer one does', () => {
    expect(COUNTDOWN_MERGE_GAP_SEC).toBe(3)
    const short = tl('1'.repeat(10) + '0'.repeat(4) + '1'.repeat(10) + '0'.repeat(36)) // 2 s gap
    expect(vocalCountdown(short, 2, dur)).toEqual({ phase: 'in', startsInSec: 0, endsInSec: 10 })
    const long = tl('1'.repeat(10) + '0'.repeat(8) + '1'.repeat(10) + '0'.repeat(32)) // 4 s gap
    expect(vocalCountdown(long, 2, dur)).toEqual({ phase: 'in', startsInSec: 0, endsInSec: 3 })
  })
})
