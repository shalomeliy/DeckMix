import { describe, expect, it } from 'vitest'
import { mp3Trim } from '@/core/mp3-gapless'

/** A first MPEG-1 Layer III frame carrying an Info tag with a LAME extension (delay, padding), behind an optional ID3v2 tag. */
function mp3(opts: {
  id3?: number
  tag?: 'Info' | 'Xing' | null
  encoder?: string
  delay?: number
  padding?: number
  mpeg2?: boolean
}): Uint8Array {
  const id3 = opts.id3 ?? 0
  const b = new Uint8Array(id3 + 1200)
  if (id3) {
    b.set([0x49, 0x44, 0x33, 4, 0, 0])
    const size = id3 - 10
    b.set([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f], 6)
  }
  const p = id3
  b[p] = 0xff
  b[p + 1] = opts.mpeg2 ? 0xf3 : 0xfb
  b[p + 2] = 0x90 // a real bitrate and sample rate: the sync search checks them
  if (opts.tag) {
    const x = p + 36
    b.set([...opts.tag].map((c) => c.charCodeAt(0)), x)
    b.set([...(opts.encoder ?? 'LAME')].map((c) => c.charCodeAt(0)), x + 120)
    const q = x + 120 + 21
    const d = opts.delay ?? 0
    const pad = opts.padding ?? 0
    b[q] = d >> 4
    b[q + 1] = ((d & 15) << 4) | (pad >> 8)
    b[q + 2] = pad & 255
  }
  return b
}

describe('mp3Trim — lining MP3 decodes up with the browser (v0.9.57)', () => {
  it('a LAME/Lavc tag: skip the header frame, the encoder delay and the 529-sample decoder delay; cut the padding at the end', () => {
    // Candy Shop (07/10): delay 576, padding 960 -> 2257 samples late and 431 too long without this
    expect(mp3Trim(mp3({ id3: 5793, tag: 'Info', delay: 576, padding: 960 }))).toEqual({ start: 2257, end: 431 })
  })
  it('a tag that names no delay still skips the header frame and the decoder delay', () => {
    // Aria Remix (07/10): Lavf, delay 0 -> 1681 samples late
    expect(mp3Trim(mp3({ tag: 'Info' }))).toEqual({ start: 1681, end: 0 })
  })
  it('Xing counts like Info, and an MPEG-2 frame is 576 samples', () => {
    expect(mp3Trim(mp3({ tag: 'Xing', mpeg2: true }))).toEqual({ start: 576 + 529, end: 0 })
  })
  it('no tag: nothing is cut — those files already line up', () => {
    expect(mp3Trim(mp3({ id3: 100, tag: null }))).toEqual({ start: 0, end: 0 })
  })
  it('Xing/Info without a LAME/Lavf/Lavc extension: only the header frame is skipped, as FFmpeg does', () => {
    // review 07/10: another encoder's bytes in that spot read as a 2752-sample delay put the grid ~148 ms late
    expect(mp3Trim(mp3({ tag: 'Info', encoder: 'XXXX', delay: 2752, padding: 2730 }))).toEqual({ start: 1152, end: 0 })
    expect(mp3Trim(mp3({ tag: 'Xing', encoder: '\0\0\0\0', mpeg2: true }))).toEqual({ start: 576, end: 0 })
  })
  it('a second ID3v2 tag holding bytes that look like a frame sync does not hide the real first frame', () => {
    const inner = mp3({ id3: 300, tag: 'Info', delay: 576, padding: 960 })
    inner.set([0xff, 0xe0, 0x00], 40) // cover art: 11 sync bits, but no valid layer or bitrate
    const b = new Uint8Array(200 + inner.length)
    b.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 1, 0x3e]) // first tag, 190 bytes of body
    b.set([0xff, 0xfb, 0x00], 50) // a "frame" with bitrate index 0 inside it
    b.set(inner, 200)
    expect(mp3Trim(b)).toEqual({ start: 2257, end: 431 })
  })
})
