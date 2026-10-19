/**
 * What an audio file really is, from its first bytes (v0.9.59).
 *
 * Why this exists: two of the owner's files were M4A saved with an `.mp3` name. Players and other DJ programs trust the
 * name, and the browser decodes such a file the slow way. The library has to say so by name instead of passing over it.
 *
 * Only signatures that cannot appear by accident count. A bare MPEG/ADTS frame-sync is two bytes (0xFF 0xEx) and random data
 * can start with them, so it is NOT enough to call a file "mp3" — MP3 is recognised only behind an ID3 tag followed by a
 * frame-sync. A file we cannot name is `null` ("unverified"), never a mismatch: a rename must rest on certainty.
 */
export type AudioFormat = 'mp3' | 'm4a' | 'wav' | 'flac' | 'ogg' | 'aiff' | 'webm'

/** Extension → the family it claims. Extensions of one family are interchangeable (an `.opus` file is an `.ogg` container). */
const FAMILY: Readonly<Record<string, AudioFormat>> = {
  mp3: 'mp3',
  wav: 'wav',
  flac: 'flac',
  m4a: 'm4a',
  m4b: 'm4a',
  mp4: 'm4a',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
  weba: 'webm',
  webm: 'webm',
  aiff: 'aiff',
  aif: 'aiff',
}

/** The one extension a rename may produce for each format — a fixed table, never text taken from the file. */
export const EXTENSION_FOR: Readonly<Record<AudioFormat, string>> = {
  mp3: 'mp3',
  m4a: 'm4a',
  wav: 'wav',
  flac: 'flac',
  ogg: 'ogg',
  aiff: 'aiff',
  webm: 'webm',
}

/** How far into the file an ID3 tag may reach before we stop trusting its size field. */
export const MAX_ID3_SKIP = 16 * 1024 * 1024

const ascii = (b: Uint8Array, at: number, n: number): string => {
  let s = ''
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}

/** Total length of an ID3v2 tag at the start of `head` (header + body + footer), or 0 when there is none. Needs 10 bytes. */
export function id3TagLength(head: Uint8Array): number {
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return 0
  // syncsafe: 7 bits per byte, so a byte with the top bit set is not a valid size and the tag is not trusted
  for (let i = 6; i < 10; i++) if (head[i] & 0x80) return 0
  const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
  const footer = head[5] & 0x10 ? 10 : 0
  return 10 + size + footer
}

/**
 * Format of the audio that starts at `b[0]` — the caller has already skipped any ID3 tag and says so in `afterId3`.
 * Needs ~12 bytes. `null` when nothing unambiguous matches.
 */
export function detectAudioFormat(b: Uint8Array, afterId3: boolean): AudioFormat | null {
  if (b.length < 4) return null
  if (ascii(b, 0, 4) === 'fLaC') return 'flac'
  if (ascii(b, 0, 4) === 'OggS') return 'ogg'
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm'
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') return 'm4a'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'wav'
  if (b.length >= 12 && ascii(b, 0, 4) === 'FORM' && (ascii(b, 8, 4) === 'AIFF' || ascii(b, 8, 4) === 'AIFC')) return 'aiff'
  // MPEG audio: frame-sync, a layer that is not "reserved", a version that is not "reserved" — and only behind an ID3 tag.
  if (afterId3 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ((b[1] >> 1) & 3) !== 0 && ((b[1] >> 3) & 3) !== 1) return 'mp3'
  return null
}

/**
 * Bare MPEG frame-sync at byte 0 (no ID3 tag). Too weak to ever *name* a file (see top of file), but enough to agree with a
 * file that already claims to be an mp3: it can only confirm "nothing contradicts the name", never trigger a rename.
 */
export function startsWithMpegFrame(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ((b[1] >> 1) & 3) !== 0 && ((b[1] >> 3) & 3) !== 1
}

const BR_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
const BR_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
const BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const BR_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
const BR_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as const

/** Byte length of the MPEG audio frame whose header starts at `b[at]`, or 0 when those bytes are not a valid header (free-format counts as invalid). */
function mpegFrameLength(b: Uint8Array, at: number): number {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return 0
  const ver = (b[at + 1] >> 3) & 3
  const layer = (b[at + 1] >> 1) & 3
  if (ver === 1 || layer === 0) return 0
  const brIdx = b[at + 2] >> 4
  const srIdx = (b[at + 2] >> 2) & 3
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return 0
  const table = ver === 3 ? (layer === 3 ? BR_V1_L1 : layer === 2 ? BR_V1_L2 : BR_V1_L3) : layer === 3 ? BR_V2_L1 : BR_V2_L23
  const kbps = table[brIdx]
  const sr = SR[ver as 0 | 2 | 3][srIdx]
  const pad = (b[at + 2] >> 1) & 1
  if (layer === 3) return (Math.floor((12 * kbps * 1000) / sr) + pad) * 4
  return Math.floor(((layer === 1 && ver !== 3 ? 72 : 144) * kbps * 1000) / sr) + pad
}

/**
 * Two MPEG frames back to back somewhere in the first `window` bytes of `b` (header, then the next header exactly one frame later).
 * Some taggers write an ID3 size that is a few dozen bytes short, so the audio starts a little after where the tag says. One
 * frame-sync is accident-prone; two at the exact distance a frame header predicts are not. Like `startsWithMpegFrame`, this only
 * confirms a file that already claims to be an mp3 — it never names a format and never triggers a rename.
 */
export function hasMpegFramesWithin(b: Uint8Array, window: number): boolean {
  for (let i = 0; i < Math.min(window, b.length - 4); i++) {
    const len = mpegFrameLength(b, i)
    if (len > 0 && mpegFrameLength(b, i + len) > 0) return true
  }
  return false
}

export interface ExtensionMismatch {
  /** what the file really is */
  actual: AudioFormat
  /** the extension a rename would give it */
  suggestedExt: string
}

/** `null` when the extension fits the content, is unknown to us, or the content could not be named. */
export function extensionMismatch(ext: string, actual: AudioFormat | null): ExtensionMismatch | null {
  if (!actual) return null
  const claimed = FAMILY[ext.toLowerCase()]
  if (!claimed || claimed === actual) return null
  return { actual, suggestedExt: EXTENSION_FOR[actual] }
}

/** Name with the extension swapped, or `null` when the name cannot safely carry the new one. */
export function renamedWithExtension(fileName: string, newExt: string): string | null {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return null
  if (!Object.values(EXTENSION_FOR).includes(newExt)) return null
  const base = fileName.slice(0, dot)
  if (/[\\/]/.test(base) || base === '.' || base === '..') return null
  return `${base}.${newExt}`
}

/** One file whose name and content disagree, as the library keeps it and the dialog lists it. */
export interface MisnamedFile {
  /** `Track.id` at scan time */
  trackId: string
  /** the file's name with its extension, as it is on disk now */
  fileName: string
  currentExt: string
  actual: AudioFormat
  suggestedExt: string
}
