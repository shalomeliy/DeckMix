import { describe, expect, it } from 'vitest'
import { customTextOf, hasMixEntryNear, isOrdinalLabel, mixEntryLabel, moveHotCue, pickHotCueSlot, shouldTriggerMixEntry } from '@/core/hotcues'
import type { HotCue } from '@/core/types'

function cue(index: number, overrides: Partial<HotCue> = {}): HotCue {
  return { index, positionSec: index * 10, label: `${index + 1}`, color: '#000', ...overrides }
}

describe('moveHotCue', () => {
  it('is a no-op when the source pad has no cue', () => {
    const cues = [cue(1)]
    expect(moveHotCue(cues, 0, 2)).toBe(cues)
  })

  it('is a no-op when source and target are the same pad', () => {
    const cues = [cue(0)]
    expect(moveHotCue(cues, 0, 0)).toBe(cues)
  })

  it('relocates onto an empty pad', () => {
    const cues = [cue(0), cue(2)]
    const next = moveHotCue(cues, 0, 1)
    expect(next.map((c) => c.index)).toEqual([1, 2])
    const moved = next.find((c) => c.positionSec === 0)
    expect(moved?.index).toBe(1)
    expect(moved?.label).toBe('2')
  })

  it('swaps with an occupied pad, keeping both cues', () => {
    const cues = [cue(0), cue(1)]
    const next = moveHotCue(cues, 0, 1)
    expect(next).toHaveLength(2)
    const wasZero = next.find((c) => c.positionSec === 0)
    const wasOne = next.find((c) => c.positionSec === 10)
    expect(wasZero?.index).toBe(1)
    expect(wasZero?.label).toBe('2')
    expect(wasOne?.index).toBe(0)
    expect(wasOne?.label).toBe('1')
  })

  it('keeps the result sorted by index', () => {
    const cues = [cue(2), cue(0)]
    const next = moveHotCue(cues, 0, 3)
    expect(next.map((c) => c.index)).toEqual([2, 3])
  })

  it('a descriptive (v0.4.7) label survives relocating onto an empty pad', () => {
    const cues = [cue(0, { label: 'Mix in' })]
    const next = moveHotCue(cues, 0, 3)
    expect(next[0]).toMatchObject({ index: 3, label: 'Mix in' })
  })

  it('a descriptive label survives swapping with an occupied pad, and the plain one it swaps with still renumbers', () => {
    const cues = [cue(0, { label: 'Mix in' }), cue(1)]
    const next = moveHotCue(cues, 0, 1)
    const moved = next.find((c) => c.label === 'Mix in')
    const plain = next.find((c) => c.label !== 'Mix in')
    expect(moved?.index).toBe(1)
    expect(plain?.index).toBe(0)
    expect(plain?.label).toBe('1')
  })
})

describe('pickHotCueSlot', () => {
  it('picks the first empty pad, in order', () => {
    expect(pickHotCueSlot([cue(0), cue(2)])).toBe(1)
  })

  it('picks index 0 when no pads are occupied', () => {
    expect(pickHotCueSlot([])).toBe(0)
  })

  it('evicts the oldest-created pad when all 8 are occupied', () => {
    const cues = Array.from({ length: 8 }, (_, i) => cue(i, { createdAt: 1000 - i }))
    // index 7 has the smallest createdAt (1000 - 7), so it is the oldest.
    expect(pickHotCueSlot(cues)).toBe(7)
  })

  it('treats a cue with no createdAt as the oldest of all', () => {
    const cues = [cue(0, { createdAt: 500 }), cue(1), cue(2, { createdAt: 900 })]
    const full = [...cues, ...Array.from({ length: 5 }, (_, i) => cue(i + 3, { createdAt: 700 + i }))]
    expect(pickHotCueSlot(full)).toBe(1)
  })
})

describe('isOrdinalLabel', () => {
  // `moveHotCue` uses this to decide whether a drag should preserve a
  // pad's label or resync it to the new slot number; `shouldTriggerMixEntry`
  // below builds on the same distinction.
  it('is true for a plain cue whose label is exactly its slot number', () => {
    expect(isOrdinalLabel(cue(2))).toBe(true) // label defaults to "3"
  })

  it('is false for a cue carrying a descriptive (mix-entry) label', () => {
    expect(isOrdinalLabel(cue(2, { label: 'Mix in' }))).toBe(false)
  })

  it('is false when the label is a number but not this pad\'s own', () => {
    // e.g. left over from before a drag moved the cue to a different index.
    expect(isOrdinalLabel(cue(2, { label: '5' }))).toBe(false)
  })
})

describe('shouldTriggerMixEntry', () => {
  // `controls.ts`'s `pressHotCue` (v0.4.9) calls this before deciding
  // whether to run the automatic transition or fall through to a plain
  // seek. The rule this pins: a mix-in pad must never become a dead button
  // — worse than a plain one — when a transition genuinely can't run.
  const mixInCue = cue(2, { label: 'Mix in', kind: 'mixEntry' })
  const plainCue = cue(2)

  it('is true for a mix-in cue when this deck is paused and the other is playing', () => {
    expect(shouldTriggerMixEntry(mixInCue, false, true)).toBe(true)
  })

  it('is false for a plain (ordinal) cue, regardless of playback state', () => {
    expect(shouldTriggerMixEntry(plainCue, false, true)).toBe(false)
  })

  it('is false when this deck is already playing — falls back to a seek, not a dead notice', () => {
    expect(shouldTriggerMixEntry(mixInCue, true, true)).toBe(false)
  })

  it('is false when the other deck is not playing — nothing to mix from', () => {
    expect(shouldTriggerMixEntry(mixInCue, false, false)).toBe(false)
  })

  it('is false when the pad has no cue at all', () => {
    expect(shouldTriggerMixEntry(undefined, false, true)).toBe(false)
  })

  it('v0.5.3: is false for a manually renamed cue — a non-ordinal label alone is no longer enough', () => {
    // Before `kind` existed, a non-ordinal label meant only one thing: a
    // saved mix-in pad. Manual rename (`renameHotCue`) also produces a
    // non-ordinal label now, on purpose, without setting `kind` — this pins
    // that pressing a renamed-but-plain pad still just seeks.
    const renamedCue = cue(2, { label: 'Vocal drop · 1:23' })
    expect(shouldTriggerMixEntry(renamedCue, false, true)).toBe(false)
  })
})

describe('customTextOf', () => {
  it('is empty for a plain (never-renamed) ordinal cue', () => {
    expect(customTextOf(cue(2))).toBe('')
  })

  it('strips the trailing " · m:ss" timestamp back off a renamed label', () => {
    expect(customTextOf(cue(2, { label: 'Vocal drop · 1:23' }))).toBe('Vocal drop')
  })

  it('also strips the older, middot-less "Mix m:ss" shape (pre-v0.5.3 saved pads)', () => {
    // `saveMixEntryHotCue` wrote bare "Mix m:ss" before v0.5.3 unified the
    // format with `renameHotCue`'s "<text> · m:ss" — a pad saved back then
    // can still be sitting in a real library. Recovering only "Mix", not
    // the whole "Mix 1:23" string, is what stops a rename from gluing a
    // second timestamp onto the first one.
    expect(customTextOf(cue(2, { label: 'Mix 1:23' }))).toBe('Mix')
  })

  it('returns a label with no recognizable timestamp suffix as-is', () => {
    expect(customTextOf(cue(2, { label: 'Vocal drop' }))).toBe('Vocal drop')
  })
})

describe('mixEntryLabel / hasMixEntryNear (v0.8.14)', () => {
  it('labels with the point time, same shape customTextOf reads', () => {
    expect(mixEntryLabel(95.7)).toBe('Mix in · 1:35')
    expect(mixEntryLabel(-3)).toBe('Mix in · 0:00')
  })

  it('a second Excellent on the same point does not add a copy', () => {
    const cues: HotCue[] = [
      { index: 0, positionSec: 64.2, label: 'Mix in · 1:04', color: '#fff', createdAt: 1, kind: 'mixEntry' },
      { index: 1, positionSec: 120, label: '2', color: '#fff', createdAt: 2 },
    ]
    expect(hasMixEntryNear(cues, 64.0)).toBe(true)
    expect(hasMixEntryNear(cues, 120)).toBe(false) // a plain pad there is not a mix-in pad
    expect(hasMixEntryNear(cues, 70)).toBe(false)
  })
})
