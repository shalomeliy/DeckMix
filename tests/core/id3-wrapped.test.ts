import { describe, expect, it } from 'vitest'
import { id3WrappedMp4Offset } from '@/core/id3-wrapped'

function id3(bodySize: number, opts: { major?: number; flags?: number } = {}): number[] {
  const s = bodySize
  return [0x49, 0x44, 0x33, opts.major ?? 3, 0, opts.flags ?? 0, (s >> 21) & 0x7f, (s >> 14) & 0x7f, (s >> 7) & 0x7f, s & 0x7f, ...new Array(s).fill(0)]
}
const ftyp = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x64, 0x61, 0x73, 0x68]
const mp3Frame = [0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]

describe('id3WrappedMp4Offset', () => {
  it('finds the MP4 behind an ID3 tag (the owner\'s file: 5608-byte body → 5618)', () => {
    expect(id3WrappedMp4Offset(Uint8Array.from([...id3(5608), ...ftyp]))).toBe(5618)
  })
  it('leaves a real MP3 alone', () => {
    expect(id3WrappedMp4Offset(Uint8Array.from([...id3(20), ...mp3Frame]))).toBeNull()
  })
  it('leaves a plain MP4 (no ID3) alone', () => {
    expect(id3WrappedMp4Offset(Uint8Array.from(ftyp))).toBeNull()
  })
  it('counts an ID3v2.4 footer', () => {
    expect(id3WrappedMp4Offset(Uint8Array.from([...id3(4, { major: 4, flags: 0x10 }), ...new Array(10).fill(0), ...ftyp]))).toBe(24)
  })
  it('is not fooled by a tag that runs past the bytes it was given', () => {
    expect(id3WrappedMp4Offset(Uint8Array.from(id3(4)))).toBeNull()
  })
})
