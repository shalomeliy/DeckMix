import { describe, expect, it } from 'vitest'
import { MIN_REGION_SEC, addRegion, effectiveTimeline, regionMask, removeLastRegion } from '@/core/sound/vocal-manual.ts'
import { CELL_NONE, CELL_UNSURE, CELL_VOCAL, type VocalTimeline } from '@/core/sound/vocal-timeline.ts'

const base = (s: string): VocalTimeline => ({ cells: Uint8Array.from([...s].map(Number)), stereo: true })
const DUR = 10 // 20 cells

describe('addRegion', () => {
  it('stores a mark, in the order he made them, and accepts the two times in either order', () => {
    const a = addRegion([], 2, 5, DUR)
    expect(a).toEqual({ ok: true, regions: [{ fromSec: 2, toSec: 5 }] })
    const b = addRegion(a.ok ? a.regions : [], 9, 7, DUR)
    expect(b.ok && b.regions).toEqual([{ fromSec: 2, toSec: 5 }, { fromSec: 7, toSec: 9 }])
  })
  it('refuses a mis-click and says why — never stores it', () => {
    expect(MIN_REGION_SEC).toBe(0.5)
    expect(addRegion([], 3, 3.2, DUR)).toEqual({ ok: false, reason: 'too-short' })
    expect(addRegion([], NaN, 3, DUR)).toEqual({ ok: false, reason: 'bad-time' })
    expect(addRegion([], 1, 2, 0)).toEqual({ ok: false, reason: 'bad-time' })
  })
  it('clamps to the song', () => {
    const r = addRegion([], -3, 99, DUR)
    expect(r.ok && r.regions).toEqual([{ fromSec: 0, toSec: DUR }])
  })
})

describe('removeLastRegion', () => {
  it('undoes the last thing he did, even when it overlapped an earlier mark', () => {
    const r = [{ fromSec: 0, toSec: 6 }, { fromSec: 4, toSec: 8 }]
    expect(removeLastRegion(r)).toEqual([{ fromSec: 0, toSec: 6 }])
    expect(removeLastRegion([])).toEqual([])
  })
})

describe('regionMask', () => {
  it('rounds a mark OUT to whole half seconds and merges overlaps', () => {
    const m = regionMask([{ fromSec: 1.2, toSec: 2.1 }, { fromSec: 2, toSec: 3 }], DUR)
    expect([...m].map(String).join('')).toBe('00111100' + '0'.repeat(12))
    expect(m.length).toBe(20)
  })
})

describe('effectiveTimeline', () => {
  const marks = [{ fromSec: 2, toSec: 4 }]
  it('without marks it is the model\'s timeline, untouched', () => {
    const b = base('0'.repeat(20))
    expect(effectiveTimeline(b, undefined, DUR)).toBe(b)
  })
  it('finished: only his marks are voice and the model\'s dashed/solid cells outside them are gone', () => {
    const b = base('1'.repeat(20))
    const t = effectiveTimeline(b, { regions: marks, finished: true }, DUR)!
    expect([...t.cells].map(String).join('')).toBe('0000' + '1111' + '0'.repeat(12))
  })
  it('not finished: his marks are laid over the model, which stays elsewhere', () => {
    const b = base('0'.repeat(10) + '2'.repeat(10))
    const t = effectiveTimeline(b, { regions: marks, finished: false }, DUR)!
    expect([...t.cells].map(String).join('')).toBe('0000' + '1111' + '00' + '2'.repeat(10))
  })
  it('not finished and no model strip: the rest is "unsure", never "none"', () => {
    const t = effectiveTimeline(null, { regions: marks, finished: false }, DUR)!
    expect(t.cells[0]).toBe(CELL_UNSURE)
    expect(t.cells[5]).toBe(CELL_VOCAL)
    expect([...t.cells].includes(CELL_NONE)).toBe(false)
  })
  it('a mark still open is drawn up to the play position, either direction', () => {
    const b = base('0'.repeat(20))
    const t = effectiveTimeline(b, undefined, DUR, { fromSec: 6, toSec: 4 })!
    expect([...t.cells].map(String).join('')).toBe('0'.repeat(8) + '1111' + '0'.repeat(8))
  })
  it('finished with no marks left is an empty strip, not the model\'s', () => {
    const t = effectiveTimeline(base('1'.repeat(20)), { regions: [], finished: true }, DUR)!
    expect([...t.cells].every((c) => c === CELL_NONE)).toBe(true)
  })
})
