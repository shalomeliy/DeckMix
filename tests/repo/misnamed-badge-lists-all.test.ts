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

  it('an untagged .mp3 that starts with an MPEG frame is not unverified, but the same bytes under another name still are', async () => {
    const frame = [0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]
    const r = await findMisnamedFiles([track('a', 'a.mp3', frame), track('b', 'b.wav', frame)])
    expect(r.unverified).toEqual(['b'])
    expect(r.misnamed).toEqual([])
  })

  it('a tagged .mp3 whose ID3 size is a few dozen bytes short is confirmed by two frames in a row, not by one stray sync', async () => {
    // MPEG1 Layer3 128 kbps 44.1 kHz, no padding: 417-byte frames
    const frame = (n: number) => [0xff, 0xfb, 0x90, 0x00, ...new Array(n - 4).fill(0)]
    const tag = [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0] // ID3, size 0: audio "should" start at 10
    const junk = new Array(47).fill(0x46)
    const good = [...tag, ...junk, ...frame(417), ...frame(417)]
    const lone = [...tag, ...junk, ...frame(417), 1, 2, 3, 4] // one sync, no second frame where it must be
    const r = await findMisnamedFiles([track('g', 'g.mp3', good), track('l', 'l.mp3', lone)])
    expect(r.unverified).toEqual(['l'])
  })

  it('320 kbps frames (1044 bytes) after a short ID3 size are read in full: the six DJ Kuper files', async () => {
    const frame = [0xff, 0xfa, 0xe0, 0x6c, ...new Array(1040).fill(0)]
    const tag = [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]
    const r = await findMisnamedFiles([track('k', 'k.mp3', [...tag, ...new Array(48).fill(0x46), ...frame, ...frame])])
    expect(r.unverified).toEqual([])
  })
})
