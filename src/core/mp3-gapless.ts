/**
 * How many samples to cut from the start and end of a decoded MP3 so it lines up with what the browser's decoder gives (v0.9.57).
 *
 * The off-main-thread decoder (minimp3) hands back every frame raw. The browser instead (1) does not play the Xing/Info header frame, which
 * is metadata, (2) drops the encoder's delay plus the 529 samples of decoder delay, both named in the LAME/Lavc tag, and (3) drops the
 * padding at the end. Without this, 2 of 5 of Shalom's MP3s came out 1681 and 2257 samples late (measured 07/10) — their beat grids would
 * have been stored 20 and 40 ms off, and every cue and SYNC built on them with it.
 *
 * No tag → nothing to cut: measured to line up with the browser to the sample on his files without one. A Xing/Info tag *without* the
 * LAME/Lavf/Lavc extension → only the header frame is skipped, exactly as FFmpeg (Chromium's decoder) does: reading delay bytes another
 * encoder never wrote put the grid up to 148 ms late (caught by review, pinned in `mp3-gapless.test.ts`).
 */
const DECODER_DELAY = 529

export function mp3Trim(bytes: Uint8Array): { start: number; end: number } {
  let p = 0
  // Back-to-back ID3v2 tags happen (a re-tagger prepending a second one); cover art inside them holds bytes that look like a frame sync.
  while (p + 10 < bytes.length && bytes[p] === 0x49 && bytes[p + 1] === 0x44 && bytes[p + 2] === 0x33) {
    const size = ((bytes[p + 6] & 0x7f) << 21) | ((bytes[p + 7] & 0x7f) << 14) | ((bytes[p + 8] & 0x7f) << 7) | (bytes[p + 9] & 0x7f)
    p += 10 + size + (bytes[p + 5] & 0x10 ? 10 : 0)
  }
  const limit = Math.min(bytes.length - 4, p + 64 * 1024)
  while (p < limit && !isLayer3Header(bytes, p)) p++
  if (p >= limit) return { start: 0, end: 0 }
  const mpeg1 = ((bytes[p + 1] >> 3) & 3) === 3
  const samplesPerFrame = mpeg1 ? 1152 : 576
  const tagAt = findTag(bytes, p, Math.min(bytes.length - 4, p + 200))
  if (tagAt < 0) return { start: 0, end: 0 }
  // The LAME extension sits 120 bytes after "Xing"/"Info"; delay and padding are its 21st-23rd bytes, 12 bits each.
  if (!hasEncoderExtension(bytes, tagAt + 120)) return { start: samplesPerFrame, end: 0 }
  const q = tagAt + 120 + 21
  let delay = 0
  let padding = 0
  if (q + 2 < bytes.length) {
    delay = (bytes[q] << 4) | (bytes[q + 1] >> 4)
    padding = ((bytes[q + 1] & 0x0f) << 8) | bytes[q + 2]
  }
  return { start: samplesPerFrame + delay + DECODER_DELAY, end: Math.max(0, padding - DECODER_DELAY) }
}

function findTag(b: Uint8Array, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    const isXing = b[i] === 0x58 && b[i + 1] === 0x69 && b[i + 2] === 0x6e && b[i + 3] === 0x67
    const isInfo = b[i] === 0x49 && b[i + 1] === 0x6e && b[i + 2] === 0x66 && b[i + 3] === 0x6f
    if (isXing || isInfo) return i
  }
  return -1
}

/** A real MPEG Layer III frame header, not just 11 set bits: version not reserved, layer III, a usable bitrate and sample rate. */
function isLayer3Header(b: Uint8Array, p: number): boolean {
  if (b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return false
  const version = (b[p + 1] >> 3) & 3
  const layer = (b[p + 1] >> 1) & 3
  const bitrate = b[p + 2] >> 4
  const rate = (b[p + 2] >> 2) & 3
  return version !== 1 && layer === 1 && bitrate !== 0 && bitrate !== 15 && rate !== 3
}

/** "LAME", "Lavf" or "Lavc" — the encoders whose extension carries delay and padding, the same three FFmpeg checks for. */
function hasEncoderExtension(b: Uint8Array, at: number): boolean {
  if (at + 4 > b.length) return false
  const s = String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
  return s === 'LAME' || s === 'Lavf' || s === 'Lavc'
}
