import { describe, expect, it } from 'vitest'
import { readTags } from '@/platform/source-fsaccess/tags'

/**
 * v0.8.3 debt: `readChunked`'s top-level RIFF/AIFF walk capped at 64 chunks,
 * so an `ID3 ` chunk sitting after that point — real DJ software writes it
 * *after* the audio payload, and other tools can pile filler chunks (cue,
 * bext, LIST, padding) ahead of it — was never reached. A second bug in the
 * same loop made it worse: a single zero-size filler chunk aborted the walk
 * outright, stranding anything after it regardless of the cap.
 */

function u32le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}

function chunk(id: string, payload: number[]): number[] {
  const bytes = [...id].map((c) => c.charCodeAt(0))
  const out = [...bytes, ...u32le(payload.length), ...payload]
  if (payload.length & 1) out.push(0) // RIFF pads odd-length chunks
  return out
}

/** Minimal ID3v2.3 tag with a single text frame. */
function id3Tag(frameId: string, value: string): number[] {
  const text = [0, ...[...value].map((c) => c.charCodeAt(0))] // encoding 0 = latin1
  const frame = [...[...frameId].map((c) => c.charCodeAt(0)), ...u32BE(text.length), 0, 0, ...text]
  const size = frame.length
  const header = [0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(size)] // "ID3", v2.3, flags 0
  return [...header, ...frame]
}
function u32BE(n: number): number[] {
  return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}
function syncsafe(n: number): number[] {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]
}

function wavFile(fillerChunks: number[][], id3Payload: number[]): File {
  const body = [...fillerChunks.flat(), ...chunk('ID3 ', id3Payload)]
  const riff = [
    ...[...'RIFF'].map((c) => c.charCodeAt(0)),
    ...u32le(4 + body.length),
    ...[...'WAVE'].map((c) => c.charCodeAt(0)),
    ...body,
  ]
  return new File([new Uint8Array(riff)], 'test.wav', { type: 'audio/wav' })
}

describe('readTags — WAV chunk walk', () => {
  it('finds an ID3 tag sitting after the old 64-chunk cap', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => chunk('jnk ', u32le(i)))
    const file = wavFile(filler, id3Tag('TIT2', 'Chunk100'))
    const tags = await readTags(file)
    expect(tags.title).toBe('Chunk100')
  })

  it('does not abort the whole walk on a zero-size filler chunk', async () => {
    const filler = [chunk('jnk ', [])] // zero-length payload
    const file = wavFile(filler, id3Tag('TIT2', 'AfterZeroChunk'))
    const tags = await readTags(file)
    expect(tags.title).toBe('AfterZeroChunk')
  })

  it('still finds a tag with no filler chunks at all (no regression)', async () => {
    const file = wavFile([], id3Tag('TIT2', 'Plain'))
    const tags = await readTags(file)
    expect(tags.title).toBe('Plain')
  })
})

/**
 * v0.8.6: hardened `readOgg` to walk real Ogg page framing to page 1 (the
 * comment header) instead of scanning raw bytes for the `\x03vorbis`/
 * `OpusTags` signature — a blind scan could land on an accidental signature
 * match inside a later page's compressed audio payload before ever
 * reaching the real header. No real OGG file exists in this environment
 * (HANDOFF.md), so this is entirely synthetic: a hand-built two-page
 * container (identification header + comment header), enough to prove the
 * page walk and the false-positive fix — not a substitute for testing
 * against a real Vorbis/Opus encoder's output.
 */
function oggPage(
  payload: number[],
  { bos = false, seq = 0 }: { bos?: boolean; seq?: number } = {},
): number[] {
  // One segment per page here — every payload in these tests is well under
  // 255 bytes, so the multi-segment/continuation rules don't come into it.
  const header = [
    ...[...'OggS'].map((c) => c.charCodeAt(0)),
    0, // stream structure version
    bos ? 0x02 : 0, // header type flag — 0x02 = beginning of stream
    ...new Array(8).fill(0), // granule position (unused by readOggPage)
    ...new Array(4).fill(0), // bitstream serial number (unused)
    ...u32le(seq),
    ...new Array(4).fill(0), // checksum (unchecked by readOggPage)
    1, // page_segments
    payload.length, // the one segment's length
  ]
  return [...header, ...payload]
}

function pushStr(out: number[], s: string) {
  const bytes = [...s].map((c) => c.charCodeAt(0))
  out.push(...u32le(bytes.length), ...bytes)
}

/** Vorbis comment header payload: packet type + "vorbis", vendor string, field count, then each "KEY=value". */
function vorbisCommentHeaderPayload(fields: string[]): number[] {
  const out = [0x03, ...[...'vorbis'].map((c) => c.charCodeAt(0))]
  pushStr(out, 'SoundGridTest')
  out.push(...u32le(fields.length))
  for (const f of fields) pushStr(out, f)
  return out
}

function oggFile(identPayload: number[], commentPayload: number[]): File {
  const bytes = [...oggPage(identPayload, { bos: true, seq: 0 }), ...oggPage(commentPayload, { seq: 1 })]
  return new File([new Uint8Array(bytes)], 'test.ogg', { type: 'audio/ogg' })
}

describe('readTags — OGG page walk', () => {
  it('reads tags from a real two-page Vorbis comment header', async () => {
    const ident = [1, 2, 3, 4] // content irrelevant — readOggPage never looks inside page 0
    const comment = vorbisCommentHeaderPayload(['TITLE=Real Header', 'ARTIST=Test Artist', 'BPM=128'])
    const tags = await readTags(oggFile(ident, comment))
    expect(tags.title).toBe('Real Header')
    expect(tags.artist).toBe('Test Artist')
    expect(tags.bpm).toBe(128)
  })

  it('does not false-positive on a signature that happens to sit in page 0 (the bug a blind byte scan had)', async () => {
    // The identification header (page 0) is opaque to this reader by design
    // — but by pure chance it contains the exact byte sequence a blind scan
    // was looking for, with a bogus title right after it. A page-walking
    // reader must never even look inside page 0's payload for this.
    const ident = [
      1, 2, 0x03, ...[...'vorbis'].map((c) => c.charCodeAt(0)), ...vorbisCommentHeaderPayload(['TITLE=Should Not Be Read']), 9,
    ]
    const comment = vorbisCommentHeaderPayload(['TITLE=Real Header'])
    const tags = await readTags(oggFile(ident, comment))
    expect(tags.title).toBe('Real Header')
  })

  it('reads tags from an Opus comment header the same way', async () => {
    const ident = [1, 2, 3, 4]
    const comment = [...[...'OpusTags'].map((c) => c.charCodeAt(0))]
    pushStr(comment, 'SoundGridTest')
    comment.push(...u32le(1))
    pushStr(comment, 'ARTIST=Opus Artist')
    const tags = await readTags(oggFile(ident, comment))
    expect(tags.artist).toBe('Opus Artist')
  })

  it('degrades to no tags rather than guessing when page framing is malformed', async () => {
    const notOgg = new File([new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0])], 'broken.ogg')
    const tags = await readTags(notOgg)
    expect(tags.title).toBeUndefined()
    expect(tags.artist).toBeUndefined()
  })
})

/**
 * v0.9.41: an ID3 frame declared Latin-1 that holds Windows-1255 Hebrew — found
 * in the owner's library (06/10) as "òåìí äøîé÷ñ". Latin text with an accent
 * or two must still read as Latin.
 */
describe('readTags — Hebrew written into a Latin-1 ID3 frame', () => {
  const mp3 = (bytes: number[]) => new File([new Uint8Array([...bytes, 0xff, 0xfb, 0x90, 0x00])], 'x.mp3')
  // "עולם הרמיקס" in Windows-1255
  const hebrew1255 = [0xf2, 0xe5, 0xec, 0xed, 0x20, 0xe4, 0xf8, 0xee, 0xe9, 0xf7, 0xf1]

  it('reads it as Hebrew', async () => {
    const tags = await readTags(mp3(id3Tag('TPE1', String.fromCharCode(...hebrew1255))))
    expect(tags.artist).toBe('עולם הרמיקס')
  })

  it('keeps Latin names with accents as Latin', async () => {
    expect((await readTags(mp3(id3Tag('TPE1', 'Beyoncé')))).artist).toBe('Beyoncé')
    expect((await readTags(mp3(id3Tag('TPE1', 'Café Olé')))).artist).toBe('Café Olé')
    expect((await readTags(mp3(id3Tag('TPE1', 'Röyksopp')))).artist).toBe('Röyksopp')
  })
})
