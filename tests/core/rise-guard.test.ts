import { describe, expect, it } from 'vitest'
import { analyzeEnergyProfile } from '@/core/structure'
import { joinWithoutCut, riseCutByQuietEntry } from '@/core/rise-guard'

/** bands = low/mid/high triples, one bucket per second; `levels` is the per-second loudness. */
function profile(levels: number[]) {
  const bands = new Float32Array(levels.length * 3)
  levels.forEach((l, i) => (bands[i * 3] = l))
  return analyzeEnergyProfile(bands, levels.length)
}
const steady = (n: number, v: number) => Array(n).fill(v)

describe('riseCutByQuietEntry', () => {
  // A: quiet-ish 0.5 for 60 s, then builds to 1.0 from 60 s on.
  const a = profile([...steady(60, 0.5), ...steady(60, 1)])
  const loudB = profile(steady(120, 0.9))
  const quietB = profile([...steady(20, 0.15), ...steady(100, 0.9)])

  it('a quiet B entering as A is about to rise cuts the rise', () => {
    const v = riseCutByQuietEntry(a, 58, quietB, 0, 6)
    expect(v.cuts).toBe(true)
    expect(v.riseRatio).toBeGreaterThan(1.25)
    expect(v.entryShare).toBeLessThan(0.6)
  })
  it('a loud B does not', () => expect(riseCutByQuietEntry(a, 58, loudB, 0, 6).cuts).toBe(false))
  it('a quiet B over a steady A does not (nothing is cut)', () => expect(riseCutByQuietEntry(a, 20, quietB, 0, 6).cuts).toBe(false))
  it('after the rise has landed, a quiet B is not cutting one', () => expect(riseCutByQuietEntry(a, 90, quietB, 0, 6).cuts).toBe(false))
  it('says "not cutting" for a song with no reading, never a guess', () => {
    const none = analyzeEnergyProfile(new Float32Array(0), 0)
    expect(riseCutByQuietEntry(none, 10, quietB, 0, 6)).toEqual({ cuts: false, riseRatio: 0, entryShare: 0 })
  })
})

describe('joinWithoutCut', () => {
  const next = (s: number) => (s + 16 < 200 ? s + 16 : null)
  const ok = { cuts: false, riseRatio: 1, entryShare: 1 }
  const bad = { cuts: true, riseRatio: 2, entryShare: 0.1 }
  it('keeps a join that is fine', () => expect(joinWithoutCut(40, next, () => ok)).toMatchObject({ sec: 40, moved: false, stuck: false }))
  it('moves to the first phrase start that is fine', () =>
    expect(joinWithoutCut(40, next, (s) => (s < 72 ? bad : ok))).toMatchObject({ sec: 72, moved: true, stuck: false }))
  it('keeps the first and says stuck when every try cuts', () =>
    expect(joinWithoutCut(40, next, () => bad)).toMatchObject({ sec: 40, moved: false, stuck: true }))
  it('stops when the song has no phrase start left', () =>
    expect(joinWithoutCut(40, () => null, () => bad)).toMatchObject({ stuck: true }))
})
