import { describe, expect, it } from 'vitest'
import { addBadEntry, excellentFirst, isBadEntry, SAME_BAD_WINDOW_SEC, withoutBad } from '@/core/bad-mixes'

describe('bad mixes', () => {
  const bad = [{ entrySec: 64, at: 1 }]
  it('matches the same entry despite a re-planned float, but not a neighbouring row', () => {
    expect(isBadEntry(bad, 64.9)).toBe(true)
    expect(isBadEntry(bad, 64 + SAME_BAD_WINDOW_SEC)).toBe(false)
    expect(isBadEntry(bad, 128)).toBe(false)
  })
  it('rating the same point again refreshes it instead of stacking', () => {
    expect(addBadEntry(bad, { entrySec: 65, at: 2 })).toEqual([{ entrySec: 65, at: 2 }])
    expect(addBadEntry(bad, { entrySec: 200, at: 2 })).toHaveLength(2)
  })
  it('withoutBad leaves the other rows as the alternative and counts the hidden ones', () => {
    const rows = [{ s: 10 }, { s: 64 }, { s: 128 }]
    const r = withoutBad(rows, (x) => x.s, bad)
    expect(r.shown.map((x) => x.s)).toEqual([10, 128])
    expect(r.hidden).toBe(1)
  })
  it('with nothing rated bad, every row stays', () => {
    expect(withoutBad([{ s: 1 }], (x) => x.s, [])).toEqual({ shown: [{ s: 1 }], hidden: 0 })
  })
  it('an Excellent point is never hidden by a Bad and comes first', () => {
    const rows = [{ s: 10 }, { s: 64 }, { s: 128 }]
    expect(withoutBad(rows, (x) => x.s, bad, [64]).shown).toHaveLength(3)
    expect(excellentFirst(rows, (x) => x.s, [128]).map((x) => x.s)).toEqual([128, 10, 64])
  })
})
