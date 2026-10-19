import { describe, expect, it } from 'vitest'
import { findMisnamedFiles } from '@/platform/source-fsaccess/misnamed'
import type { Track } from '@/core/types'

// The amber badge counted unverified files the dialog never listed ("25 unverified" -> window said nothing was left).
// Every file the badge counts must come back by id so the dialog can name it.
const track = (id: string, name: string, bytes: number[] | 'throw'): Track =>
  ({
    id,
    handle: {
      getFile: async () => {
        if (bytes === 'throw') throw new Error('locked')
        return new File([new Uint8Array(bytes)], name)
      },
    },
  }) as unknown as Track

describe('misnamed report', () => {
  it('returns unverified and unreadable files by id, not as bare counts', async () => {
    const r = await findMisnamedFiles([track('a', 'a.mp3', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), track('b', 'b.mp3', 'throw')])
    expect(r.unverified).toEqual(['a'])
    expect(r.unreadable).toEqual(['b'])
  })
})
