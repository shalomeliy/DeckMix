import { describe, expect, it } from 'vitest'
import { parseVocalMarksFile, vocalMarksExportText } from '@/core/sound/vocal-manual-file.ts'
import type { VocalManualTag } from '@/core/sound/vocal-manual.ts'

const H = 'a'.repeat(64)
const tag = (over: Partial<VocalManualTag> = {}): VocalManualTag => ({
  schema: 1, contentHash: H, trackId: 'House/x.mp3', name: 'x', genre: 'House', regions: [{ fromSec: 1, toSec: 4 }], finished: true, updatedAt: 5, ...over,
})

describe('vocal marks file', () => {
  it('round-trips what was exported, byte-meaningfully', () => {
    const t = [tag(), tag({ contentHash: 'b'.repeat(64), name: 'y', finished: false, regions: [] })]
    const r = parseVocalMarksFile(vocalMarksExportText(t, 1))
    expect(r.rejected).toEqual([])
    expect(r.tags).toEqual(t)
  })
  it('refuses a file that is not ours, whole, with the reason', () => {
    expect(() => parseVocalMarksFile('nope')).toThrow('not JSON')
    expect(() => parseVocalMarksFile(JSON.stringify({ app: 'DeckMix', kind: 'tags', schema: 2 }))).toThrow('not a DeckMix vocal-marks file')
    expect(() => parseVocalMarksFile(JSON.stringify({ app: 'DeckMix', kind: 'vocal-marks', schema: 9, marks: [] }))).toThrow('schema 9')
    expect(() => parseVocalMarksFile(JSON.stringify({ app: 'DeckMix', kind: 'vocal-marks', schema: 1 }))).toThrow('no list')
  })
  it('refuses a bad mark by name and keeps the good ones — never a silent partial import', () => {
    const bad = [
      { ...tag({ name: 'bad-hash' }), contentHash: 'zz' },
      tag({ name: 'bad-region', regions: [{ fromSec: 5, toSec: 3 }] }),
      tag({ name: 'neg', regions: [{ fromSec: -1, toSec: 3 }] }),
      { ...tag({ name: 'bad-flag' }), finished: 'yes' },
      null,
    ]
    const r = parseVocalMarksFile(JSON.stringify({ app: 'DeckMix', kind: 'vocal-marks', schema: 1, marks: [tag({ name: 'good' }), ...bad] }))
    expect(r.tags.map((t) => t.name)).toEqual(['good'])
    expect(r.rejected.map((x) => x.name)).toEqual(['bad-hash', 'bad-region', 'neg', 'bad-flag', '(no name)'])
    expect(r.rejected.every((x) => x.reason.length > 0)).toBe(true)
  })
})

describe('taught songs in the file', () => {
  it('a taught flag survives the round trip, and only on a finished song', () => {
    const taught = tag({ taught: true, taughtAt: 7 })
    const draft = { ...tag({ name: 'draft', finished: false }), taught: true, taughtAt: 9 } as VocalManualTag
    const r = parseVocalMarksFile(vocalMarksExportText([taught, draft, tag({ name: 'plain' })], 1))
    expect(r.tags.find((t) => t.name === 'x')?.taught).toBe(true)
    expect(r.tags.find((t) => t.name === 'x')?.taughtAt).toBe(7)
    expect(r.tags.find((t) => t.name === 'draft')?.taught).toBeUndefined() // an unfinished song cannot be a lesson, whatever the file says
    expect(r.tags.find((t) => t.name === 'plain')?.taught).toBeUndefined()
  })
})
