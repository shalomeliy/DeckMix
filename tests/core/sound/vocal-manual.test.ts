import { describe, expect, it } from 'vitest'
import { MARK_LEAD_SEC, MARK_TAIL_SEC, MIN_REGION_SEC, addMarkedRegion, barLineAtOrAfterSec, barLineAtOrBeforeSec, drawnBarGrid, markedSpan, addRegion, effectiveTimeline, manualLabels, moveRegionEdge, removeLastRegion, undoLastEnd } from '@/core/sound/vocal-manual.ts'
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

describe('manualLabels', () => {
  it('rounds a mark OUT to whole half seconds and merges overlaps', () => {
    const m = manualLabels([{ fromSec: 1.2, toSec: 2.1 }, { fromSec: 2, toSec: 3 }], DUR)
    expect([...m].map(String).join('')).toBe('00111100' + '0'.repeat(12))
    expect(m.length).toBe(20)
  })
  it('a black mark paints over an earlier purple one, and a later purple one over a black one: the last mark wins', () => {
    const m = manualLabels([{ fromSec: 0, toSec: 5 }, { fromSec: 2, toSec: 3, kind: 'none' }, { fromSec: 2.5, toSec: 3.5 }], DUR)
    expect([...m].map(String).join('')).toBe('1111' + '0' + '11111' + '0'.repeat(10)) // 0-2 s voice, 2-2.5 s none, 2.5-5 s voice again
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

describe('reaction-time lead and tail', () => {
  it('"started" lands half a second before the press and "ended" half a second after it, clamped to the song', () => {
    expect(MARK_LEAD_SEC).toBe(0.5)
    expect(MARK_TAIL_SEC).toBe(0.5)
    const r = addMarkedRegion([], 4, 7, 20)
    expect(r.ok && r.regions).toEqual([{ fromSec: 4 - MARK_LEAD_SEC, toSec: 7 + MARK_TAIL_SEC }])
    const edge = addMarkedRegion([], 0.4, 19.8, 20)
    expect(edge.ok && edge.regions).toEqual([{ fromSec: 0, toSec: 20 }])
  })
  it('works when he seeked back between the presses', () => {
    const r = addMarkedRegion([], 9, 5, 20)
    expect(r.ok && r.regions).toEqual([{ fromSec: 5 - MARK_LEAD_SEC, toSec: 9 + MARK_TAIL_SEC }])
  })
  it('two accidental presses are still refused — the widening does not rescue a mis-click', () => {
    expect(addMarkedRegion([], 5, 5.2, 20)).toEqual({ ok: false, reason: 'too-short' })
    expect(addMarkedRegion([], NaN, 5, 20)).toEqual({ ok: false, reason: 'bad-time' })
  })
})

describe('snap to the yellow bar line before the press (the owner, 04/10)', () => {
  // 120 BPM → a bar is 2 s; the first yellow line at 0.3 s, then 2.3, 4.3, 6.3 …
  const GRID = { bpm: 120, offsetSec: 0.3 }
  it('the line at or before a time: one already passed, a press on a line keeps it, before the first line goes below 0', () => {
    expect(barLineAtOrBeforeSec(5, GRID)).toBeCloseTo(4.3, 9)
    expect(barLineAtOrBeforeSec(4.3, GRID)).toBeCloseTo(4.3, 9)
    expect(barLineAtOrBeforeSec(6.29, GRID)).toBeCloseTo(4.3, 9)
    expect(barLineAtOrBeforeSec(0.1, GRID)).toBeCloseTo(-1.7, 9)
  })
  it('the line at or after a time: the next one, a press on a line keeps it', () => {
    expect(barLineAtOrAfterSec(5, GRID)).toBeCloseTo(6.3, 9)
    expect(barLineAtOrAfterSec(6.3, GRID)).toBeCloseTo(6.3, 9)
    expect(barLineAtOrAfterSec(4.31, GRID)).toBeCloseTo(6.3, 9)
  })
  it('"started" goes back to the yellow line before the press and "ended" forward to the one after it — a voice ending mid-bar is kept', () => {
    const r = addMarkedRegion([], 5.1, 11.9, 60, 'voice', GRID)
    expect(r.ok).toBe(true)
    const m = r.ok ? r.regions[0]! : null
    expect(m?.fromSec).toBeCloseTo(4.3, 9)
    expect(m?.toSec).toBeCloseTo(12.3, 9)
    expect(m?.kind).toBeUndefined()
  })
  it('a black mark snaps the same way, and seeking back between the presses still works', () => {
    const r = addMarkedRegion([], 11.9, 5.1, 60, 'none', GRID)
    const m = r.ok ? r.regions[0]! : null
    expect(m?.fromSec).toBeCloseTo(4.3, 9)
    expect(m?.toSec).toBeCloseTo(12.3, 9)
    expect(m?.kind).toBe('none')
  })
  it('two presses inside one bar make that whole bar', () => {
    const s = markedSpan(4.5, 5.5, GRID)
    expect(s.fromSec).toBeCloseTo(4.3, 9)
    expect(s.toSec).toBeCloseTo(6.3, 9)
  })
  it('a start before the first line is clamped to the song start; a mis-click is still refused before any snapping', () => {
    const r = addMarkedRegion([], 0.1, 3, 60, 'voice', GRID)
    expect(r.ok && r.regions[0]!.fromSec).toBe(0)
    expect(addMarkedRegion([], 5, 5.2, 60, 'voice', GRID)).toEqual({ ok: false, reason: 'too-short' })
  })
  it('presses before the first line that would clamp to a sliver end on the next line instead of being refused as too short', () => {
    const r = addMarkedRegion([], 0.05, 0.95, 60, 'voice', GRID)
    expect(r.ok && r.regions[0]!.fromSec).toBe(0)
    expect(r.ok && r.regions[0]!.toSec).toBeCloseTo(2.3, 9)
  })
  it('snaps to the lines the waveform draws: a BPM with no detected grid draws (and snaps to) lines from 0; no BPM → none', () => {
    expect(drawnBarGrid({ bpm: 120, beatGrid: null })).toEqual({ bpm: 120, offsetSec: 0 })
    expect(drawnBarGrid({ bpm: 120, beatGrid: GRID })).toEqual(GRID)
    expect(drawnBarGrid({ bpm: null, beatGrid: null })).toBeNull()
  })
  it('undo of a mark saved with the old half-second lead takes the lead back off (it is not on a line)', () => {
    const u = undoLastEnd([{ fromSec: 4.0, toSec: 9 }], GRID)
    expect(u.reopenStartPressSec).toBeCloseTo(4.5, 9)
  })
  it('no grid, or a broken one → the old half second', () => {
    expect(markedSpan(4, 7, null)).toEqual({ fromSec: 4 - MARK_LEAD_SEC, toSec: 7 + MARK_TAIL_SEC })
    expect(markedSpan(4, 7, { bpm: 0, offsetSec: 0 })).toEqual({ fromSec: 4 - MARK_LEAD_SEC, toSec: 7 + MARK_TAIL_SEC })
  })
  it('undo of "ended" reopens on the snapped start, and pressing "ended" again gives the same start', () => {
    const made = addMarkedRegion([], 5.1, 11.9, 60, 'voice', GRID)
    const u = undoLastEnd(made.ok ? made.regions : [], GRID)
    expect(u.reopenStartPressSec).toBeCloseTo(4.3, 9)
    const again = addMarkedRegion(u.regions, u.reopenStartPressSec ?? 0, 14.4, 60, 'voice', GRID)
    expect(again.ok && again.regions[0]!.fromSec).toBeCloseTo(4.3, 9)
    expect(again.ok && again.regions[0]!.toSec).toBeCloseTo(16.3, 9)
  })
})

describe('undoLastEnd (a wrong "ended" press)', () => {
  it('takes the mark back to open at the press that started it, so pressing "ended" again fixes it', () => {
    const made = addMarkedRegion([], 10, 15, 60)
    expect(made.ok).toBe(true)
    const regions = made.ok ? made.regions : []
    const u = undoLastEnd(regions)
    expect(u.regions).toEqual([])
    expect(u.reopenStartPressSec).toBe(10) // the start press, lead taken back off
    const again = addMarkedRegion(u.regions, u.reopenStartPressSec ?? 0, 20, 60)
    expect(again.ok && again.regions).toEqual([{ fromSec: 10 - MARK_LEAD_SEC, toSec: 20 + MARK_TAIL_SEC }])
  })
  it('only the last mark is undone, and nothing to undo is nothing', () => {
    expect(undoLastEnd([{ fromSec: 1, toSec: 3 }, { fromSec: 8, toSec: 12 }]).regions).toEqual([{ fromSec: 1, toSec: 3 }])
    expect(undoLastEnd([])).toEqual({ regions: [], reopenStartPressSec: null, reopenKind: 'voice' })
  })
})

describe('moveRegionEdge (dragging a purple bar\'s edge)', () => {
  const r = [{ fromSec: 10, toSec: 20 }, { fromSec: 30, toSec: 40 }]
  it('moves just the chosen edge of the chosen mark', () => {
    expect(moveRegionEdge(r, 1, 'from', 31.234, 60)).toEqual([r[0], { fromSec: 31.23, toSec: 40 }])
    expect(moveRegionEdge(r, 0, 'to', 25, 60)).toEqual([{ fromSec: 10, toSec: 25 }, r[1]])
  })
  it('never lets the edges cross or get closer than the minimum, and never leaves the song', () => {
    expect(moveRegionEdge(r, 0, 'from', 99, 60)).toEqual([{ fromSec: 20 - MIN_REGION_SEC, toSec: 20 }, r[1]])
    expect(moveRegionEdge(r, 0, 'to', -5, 60)).toEqual([{ fromSec: 10, toSec: 10 + MIN_REGION_SEC }, r[1]])
    expect(moveRegionEdge(r, 0, 'from', -5, 60)?.[0].fromSec).toBe(0)
    expect(moveRegionEdge(r, 1, 'to', 999, 60)?.[1].toSec).toBe(60)
  })
  it('refuses what it cannot do, so the caller keeps what it had', () => {
    expect(moveRegionEdge(r, 5, 'from', 1, 60)).toBeNull()
    expect(moveRegionEdge(r, 0, 'from', NaN, 60)).toBeNull()
    expect(moveRegionEdge(r, 0, 'from', 1, 0)).toBeNull()
  })
})

describe('black marks ("no voice")', () => {
  it('in a draft, a black mark paints over the model\'s voice guess; the rest of the guess stays', () => {
    const b = base('1'.repeat(20))
    const t = effectiveTimeline(b, { regions: [{ fromSec: 2, toSec: 4, kind: 'none' }], finished: false }, DUR)!
    expect([...t.cells].map(String).join('')).toBe('1111' + '0000' + '1'.repeat(12))
  })
  it('a mark still open as black is drawn black up to the play position', () => {
    const t = effectiveTimeline(base('1'.repeat(20)), undefined, DUR, { fromSec: 4, toSec: 6, kind: 'none' })!
    expect([...t.cells].map(String).join('')).toBe('1'.repeat(8) + '0000' + '1'.repeat(8))
  })
  it('the kind survives adding, dragging an edge and undoing the end', () => {
    const made = addMarkedRegion([], 10, 15, 60, 'none')
    const regions = made.ok ? made.regions : []
    expect(regions[0].kind).toBe('none')
    expect(moveRegionEdge(regions, 0, 'to', 30, 60)?.[0].kind).toBe('none')
    expect(undoLastEnd(regions).reopenKind).toBe('none')
    expect(undoLastEnd([{ fromSec: 1, toSec: 3 }]).reopenKind).toBe('voice')
  })
  it('a purple mark is stored exactly as before (no kind), so older files and exports are unchanged', () => {
    const made = addMarkedRegion([], 10, 15, 60)
    expect(made.ok && 'kind' in made.regions[0]).toBe(false)
  })
})
