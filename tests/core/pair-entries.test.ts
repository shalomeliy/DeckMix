import { describe, expect, it } from 'vitest'
import { addPairEntry, entriesOf, MAX_ENTRIES_PER_PAIR, SAME_ENTRY_WINDOW_SEC } from '@/core/pair-entries'

describe('entriesOf', () => {
  it('reads a record written before v0.9.68 as a list of one', () => {
    expect(entriesOf({ entrySec: 64, exitSec: 200 })).toEqual([{ entrySec: 64, exitSec: 200, at: 0 }])
  })
  it('keeps pre-v0.8.16 records (no exitSec) too', () => {
    expect(entriesOf({ entrySec: 64 })[0].exitSec).toBeUndefined()
  })
  it('returns the stored list when there is one', () => {
    const entries = [{ entrySec: 10, at: 1 }, { entrySec: 90, at: 2 }]
    expect(entriesOf({ entrySec: 90, entries })).toBe(entries)
  })
})

describe('addPairEntry', () => {
  it('appends a different point instead of replacing the first', () => {
    const r = addPairEntry([{ entrySec: 64, at: 1 }], { entrySec: 128, at: 2 })
    expect(r.entries.map((e) => e.entrySec)).toEqual([64, 128])
    expect(r.dropped).toBe(false)
  })
  it('treats a point within the window as the same one and updates it', () => {
    const r = addPairEntry([{ entrySec: 64, exitSec: 100, at: 1 }], { entrySec: 64 + SAME_ENTRY_WINDOW_SEC - 1, exitSec: 110, at: 2 })
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].exitSec).toBe(110)
  })
  it('at exactly the window it is a different point', () => {
    expect(addPairEntry([{ entrySec: 64, at: 1 }], { entrySec: 64 + SAME_ENTRY_WINDOW_SEC, at: 2 }).entries).toHaveLength(2)
  })
  it('past the cap drops the oldest and says so', () => {
    let entries = Array.from({ length: MAX_ENTRIES_PER_PAIR }, (_, i) => ({ entrySec: i * 20, at: i + 1 }))
    const r = addPairEntry(entries, { entrySec: 999, at: 100 })
    expect(r.dropped).toBe(true)
    expect(r.entries).toHaveLength(MAX_ENTRIES_PER_PAIR)
    expect(r.entries.some((e) => e.entrySec === 0)).toBe(false)
    expect(r.entries.some((e) => e.entrySec === 999)).toBe(true)
    entries = r.entries
  })
  it('reads and merges 1000 pairs in well under 50 ms', () => {
    const t0 = performance.now()
    for (let i = 0; i < 1000; i++) addPairEntry(entriesOf({ entrySec: i, entries: [{ entrySec: i, at: 1 }, { entrySec: i + 50, at: 2 }] }), { entrySec: i + 100, at: 3 })
    expect(performance.now() - t0).toBeLessThan(50)
  })
})
