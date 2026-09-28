/**
 * A WAV the decoder refuses over one empty chunk (v0.12.7).
 *
 * Two of the owner's House tracks ("Do It To It", "Friday" — both Buskilaz
 * remixes) end in a `LIST` chunk of size 0. A LIST must at least carry its
 * 4-byte list type, so Chromium's decoder and ffmpeg ("too short LIST tag")
 * both reject the whole file, although its `fmt `/`data` are perfectly good
 * 16-bit PCM. The tracks showed in the library with their tag BPM, yet could
 * not be analysed or played.
 *
 * Returns a copy without the too-short LIST chunks and with the RIFF size
 * fixed, for the decoder only — the file on disk is never written. `null`
 * means "nothing to repair": any other WAV, and anything that is not RIFF/WAVE,
 * goes to the decoder exactly as read.
 */
export function repairWav(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') return null
  const keep: [number, number][] = []
  let dropped = false
  let p = 12
  while (p + 8 <= bytes.length) {
    const size = u32le(bytes, p + 4)
    const end = Math.min(bytes.length, p + 8 + size + (size & 1))
    if (tag(bytes, p) === 'LIST' && size < 4) dropped = true
    else keep.push([p, end])
    p = end
  }
  if (!dropped) return null
  const total = 12 + keep.reduce((n, [a, b]) => n + (b - a), 0)
  const out = new Uint8Array(total)
  out.set(bytes.subarray(0, 12))
  let o = 12
  for (const [a, b] of keep) {
    out.set(bytes.subarray(a, b), o)
    o += b - a
  }
  new DataView(out.buffer).setUint32(4, total - 8, true)
  return out
}

function tag(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}
