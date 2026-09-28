/**
 * Where an MP4 hiding behind an ID3 tag really starts (v0.12.6).
 *
 * Some downloaders save an M4A (AAC in MP4, often DASH-fragmented), put an
 * ID3 tag in front of it and name the file `.mp3`. Chromium's decoder sees
 * `ID3`, expects MP3 frames, finds `ftyp`, and refuses the whole file — so the
 * owner's "סטטיק - בלנסיאגה" showed "n/a" for BPM, could not be played, and its
 * length came from the tag's TLEN (4:43) instead of the audio (2:20). The
 * audio after the tag is a perfectly ordinary MP4; the caller hands the
 * decoder (and the tag reader) the bytes from this offset instead.
 *
 * `null` means "not this case" — a real MP3, or anything else, is untouched.
 */
export function id3WrappedMp4Offset(bytes: Uint8Array): number | null {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)
  // ID3v2.4 footer flag: the tag carries 10 more bytes after its body.
  const end = 10 + size + (bytes[3] === 4 && bytes[5] & 0x10 ? 10 : 0)
  if (end + 8 > bytes.length) return null
  const isFtyp = bytes[end + 4] === 0x66 && bytes[end + 5] === 0x74 && bytes[end + 6] === 0x79 && bytes[end + 7] === 0x70
  return isFtyp ? end : null
}
