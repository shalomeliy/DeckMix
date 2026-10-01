import { describe, expect, it } from 'vitest'
import {
  CELL_NONE,
  CELL_UNSURE,
  CELL_VOCAL,
  dashedFraction,
  stateOfTimeline,
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
