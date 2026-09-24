/**
 * Read metadata straight out of the file headers — no audio decoding.
 *
 * A DJ library is almost always already tagged (DJ and music programs write
 * BPM and key back into the files), so reading beats analysing: the BPM/Key/Time
 * columns fill in for the whole library in seconds instead of waiting for the
 * analysis engine (v0.3/v0.4). Analysis wins when it eventually runs — see
 * `loadTrackToDeck`.
 *
 * Everything here is byte-range reads over the `File`; we never pull a whole
 * track into memory. Formats: ID3v2 (MP3/AIFF/WAV), MP4/M4A atoms, FLAC/OGG
 * Vorbis comments, plus a Serato `Autotags` fallback for BPM.
 * Read-only — nothing is ever written back to the user's files.
 */

export interface TrackTags {
  /**
   * The file could not be READ — deleted mid-scan, permission withdrawn, the
   * drive gone — as opposed to being read fine and carrying no tags. The two
   * used to arrive at the caller identically, so a library where half the files
   * had vanished looked exactly like a library of untagged files. That is the
   * silent skip of `59c5fe5` one layer down (v0.2.8).
   */
  unreadable?: boolean
  bpm?: number
  /** display spelling, e.g. `Am`, `F#` */
  key?: string
  /** Camelot wheel code, e.g. `8A` — what harmonic matching compares */
  camelot?: string
  artist?: string
  title?: string
  album?: string
  durationSec?: number
}

// ---------------------------------------------------------------- byte utils

const latin1 = new TextDecoder('latin1')
const utf8 = new TextDecoder('utf-8')
const utf16le = new TextDecoder('utf-16le')
const utf16be = new TextDecoder('utf-16be')

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}
function u32le(b: Uint8Array, o: number): number {
  return ((b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o]) >>> 0
}
function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1]
}
function ascii(b: Uint8Array, o: number, n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i])
  return s
}
/** ID3 "syncsafe" integer — 7 bits per byte. */
function syncsafe(b: Uint8Array, o: number): number {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f)
}

async function slice(file: File, start: number, length: number): Promise<Uint8Array> {
  if (start >= file.size || length <= 0) return new Uint8Array(0)
  const end = Math.min(file.size, start + length)
  return new Uint8Array(await file.slice(start, end).arrayBuffer())
}

function fromBase64(s: string): Uint8Array | null {
  try {
    // Serato wraps its payloads in base64 with embedded newlines and NULs
    let clean = s.replace(/[^A-Za-z0-9+/]/g, '')
    clean = clean.slice(0, clean.length - (clean.length % 4))
    if (!clean) return null
    const bin = atob(clean)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

// ------------------------------------------------------------ value cleaning

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const v = parseFloat(raw.replace(',', '.'))
  if (!isFinite(v) || v <= 0) return undefined
  return v
}

/** BPM values outside this are tag noise (0, 1, 999, ms-per-beat, …). */
function bpmValue(raw: string | number | undefined): number | undefined {
  const v = typeof raw === 'number' ? raw : num(raw)
  if (v == null) return undefined
  if (v < 40 || v > 220) return undefined
  return Math.round(v * 100) / 100
}

function text(raw: string | undefined): string | undefined {
  if (raw == null) return undefined
  // tag fields are NUL-terminated; keep only what precedes the first terminator
  const nul = raw.indexOf('\u0000')
  const s = (nul < 0 ? raw : raw.slice(0, nul)).trim()
  return s ? s : undefined
}

// ------------------------------------------------------------------- musical

// Camelot wheel, indexed 1..12. Used both to normalise spelling (Gb → F#) and
// to give the recommender a comparable code.
const CAMELOT_MAJOR = ['B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E']
const CAMELOT_MINOR = ['Abm', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'Dbm']
// pitch class (C=0) → Camelot number
const MAJOR_PC = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const MINOR_PC = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]
const NOTE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export interface ParsedKey {
  key: string
  camelot: string
}

/**
 * Accepts musical (`Am`, `F#m`, `Bb`, `A minor`), Camelot (`8A`) and Open Key
 * (`1m`) spellings — DJ software disagrees about which it writes.
 */
export function parseKey(raw: string | undefined): ParsedKey | null {
  const s = raw?.trim().replace(/\s+/g, ' ')
  if (!s) return null

  const camelot = /^(\d{1,2})\s*([ABab])$/.exec(s)
  if (camelot) {
    const n = Number(camelot[1])
    if (n < 1 || n > 12) return null
    const minor = camelot[2].toUpperCase() === 'A'
    return { key: (minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[n - 1], camelot: `${n}${minor ? 'A' : 'B'}` }
  }

  const openKey = /^(\d{1,2})\s*([mdMD])$/.exec(s)
  if (openKey) {
    const n = Number(openKey[1])
    if (n < 1 || n > 12) return null
    const minor = openKey[2].toLowerCase() === 'm'
    const c = ((n + 6) % 12) + 1
    return { key: (minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[c - 1], camelot: `${c}${minor ? 'A' : 'B'}` }
  }

  const musical = /^([A-Ga-g])\s*([#♯b♭]?)\s*(m|min|minor|maj|major|d|M)?$/.exec(s)
  if (musical) {
    let pc = NOTE_PC[musical[1].toUpperCase()]
    if (musical[2] === '#' || musical[2] === '♯') pc = (pc + 1) % 12
    else if (musical[2] === 'b' || musical[2] === '♭') pc = (pc + 11) % 12
    const q = musical[3] ?? ''
    // a bare `M` means major; a bare `m` (or min/minor) means minor
    const minor = q === 'm' || q.toLowerCase() === 'min' || q.toLowerCase() === 'minor'
    const c = (minor ? MINOR_PC : MAJOR_PC)[pc]
    return { key: (minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[c - 1], camelot: `${c}${minor ? 'A' : 'B'}` }
  }

  return null
}

function applyKey(tags: TrackTags, raw: string | undefined) {
  if (tags.camelot) return
  const parsed = parseKey(raw)
  if (parsed) {
    tags.key = parsed.key
    tags.camelot = parsed.camelot
  } else if (!tags.key) {
    // unknown notation — still show it rather than dropping the user's data
    tags.key = text(raw)
  }
}

// ----------------------------------------------------------------- Serato

/** `Serato Autotags` payload: `01 01` then \0-terminated ASCII bpm, gain, gain. */
function seratoAutotagsBpm(data: Uint8Array): number | undefined {
  if (data.length < 3) return undefined
  const body = data[0] === 1 && data[1] === 1 ? data.subarray(2) : data
  return bpmValue(latin1.decode(body).split('\u0000')[0])
}

// -------------------------------------------------------------------- ID3v2

/** Splits a text frame payload (encoding byte + fields) into its strings. */
function id3Text(payload: Uint8Array): string[] {
  if (payload.length < 2) return []
  const enc = payload[0]
  const body = payload.subarray(1)
  let s: string
  if (enc === 1) {
    if (body[0] === 0xff && body[1] === 0xfe) s = utf16le.decode(body.subarray(2))
    else if (body[0] === 0xfe && body[1] === 0xff) s = utf16be.decode(body.subarray(2))
    else s = utf16le.decode(body)
  } else if (enc === 2) s = utf16be.decode(body)
  else if (enc === 3) s = utf8.decode(body)
  else s = latin1.decode(body)
  return s.replace(/\uFEFF/g, '').split('\u0000')
}

/** `GEOB` body: encoding, mime\0, filename\0, description\0, payload. */
function id3Geob(payload: Uint8Array): { desc: string; data: Uint8Array } | null {
  if (payload.length < 4 || payload[0] !== 0) return null // Serato always writes latin1
  let p = 1
  const cstr = () => {
    const start = p
    while (p < payload.length && payload[p] !== 0) p++
    const s = latin1.decode(payload.subarray(start, p))
    p++
    return s
  }
  cstr() // mime
  cstr() // filename
  const desc = cstr()
  if (p > payload.length) return null
  return { desc, data: payload.subarray(p) }
}

function parseId3Frames(body: Uint8Array, major: number, tags: TrackTags) {
  let p = 0
  const idLen = major <= 2 ? 3 : 4
  const hdrLen = major <= 2 ? 6 : 10
  const seen: Record<string, string> = {}

  while (p + hdrLen <= body.length) {
    const id = ascii(body, p, idLen)
    if (!/^[A-Z][A-Z0-9]+$/.test(id)) break // padding or garbage — done

    let size: number
    if (major <= 2) size = (body[p + 3] << 16) | (body[p + 4] << 8) | body[p + 5]
    else if (major === 4) {
      // v2.4 says syncsafe, but plenty of taggers write a plain u32 — a high bit
      // in any size byte proves it isn't syncsafe.
      const plain = u32be(body, p + 4)
      const nonSyncsafe = (body[p + 4] | body[p + 5] | body[p + 6] | body[p + 7]) & 0x80
      size = nonSyncsafe ? plain : syncsafe(body, p + 4)
    } else size = u32be(body, p + 4)

    const start = p + hdrLen
    if (size <= 0 || start + size > body.length) break
    const payload = body.subarray(start, start + size)
    p = start + size

    if (id === 'GEOB' || id === 'GEO') {
      const geob = id3Geob(payload)
      if (geob?.desc === 'Serato Autotags') {
        const bpm = seratoAutotagsBpm(geob.data)
        if (bpm != null) seen.SERATO_BPM = String(bpm)
      }
      continue
    }

    if (id[0] !== 'T') continue
    const fields = id3Text(payload)
    if (id === 'TXXX' || id === 'TXX') {
      const desc = fields[0]?.trim().toLowerCase() ?? ''
      const value = text(fields[1])
      if (!value) continue
      if (desc === 'initialkey' || desc === 'initial key' || desc === 'key') seen.TKEY ??= value
      else if (desc === 'bpm' || desc === 'tempo') seen.TBPM ??= value
      continue
    }
    const value = text(fields[0])
    if (value) seen[id] ??= value
  }

  const pick = (...ids: string[]) => {
    for (const id of ids) if (seen[id]) return seen[id]
    return undefined
  }
  tags.bpm ??= bpmValue(pick('TBPM', 'TBP')) ?? bpmValue(pick('SERATO_BPM'))
  applyKey(tags, pick('TKEY', 'TKE'))
  tags.artist ??= pick('TPE1', 'TP1')
  tags.title ??= pick('TIT2', 'TT2')
  tags.album ??= pick('TALB', 'TAL')
  const lenMs = num(pick('TLEN', 'TLE'))
  if (lenMs != null && lenMs > 1000) tags.durationSec ??= lenMs / 1000
}

const MAX_ID3 = 1_500_000

/** Reads the ID3v2 tag at `offset`; returns the total tag size (0 if absent). */
async function readId3(file: File, offset: number, tags: TrackTags): Promise<number> {
  const head = await slice(file, offset, 10)
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return 0
  const major = head[3]
  const flags = head[5]
  const size = syncsafe(head, 6)
  if (size <= 0) return 0

  const body = await slice(file, offset + 10, Math.min(size, MAX_ID3))
  let start = 0
  if (flags & 0x40) {
    // extended header — skip it before the frame loop
    start = major >= 4 ? syncsafe(body, 0) : 4 + u32be(body, 0)
  }
  if (start < body.length) parseId3Frames(body.subarray(start), major, tags)
  return size + 10
}

// --------------------------------------------------------------- MP3 length

const MP3_RATES = [
  [11025, 12000, 8000], // MPEG 2.5
  [0, 0, 0],
  [22050, 24000, 16000], // MPEG 2
  [44100, 48000, 32000], // MPEG 1
]
const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]

/**
 * Duration from the first MPEG frame: exact via a Xing/VBRI frame count,
 * otherwise from the CBR bitrate. TLEN is rarely present, and the Time column
 * is worth more than it costs.
 */
async function mp3Duration(file: File, audioStart: number): Promise<number | undefined> {
  const buf = await slice(file, audioStart, 16384)
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue
    const version = (buf[i + 1] >> 3) & 3
    const layer = (buf[i + 1] >> 1) & 3
    const bitrateIdx = (buf[i + 2] >> 4) & 15
    const rateIdx = (buf[i + 2] >> 2) & 3
    if (version === 1 || layer !== 1 || rateIdx === 3 || bitrateIdx === 0 || bitrateIdx === 15) continue

    const sampleRate = MP3_RATES[version][rateIdx]
    const mpeg1 = version === 3
    const kbps = (mpeg1 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIdx]
    const perFrame = mpeg1 ? 1152 : 576
    if (!sampleRate || !kbps) continue

    const mono = ((buf[i + 3] >> 6) & 3) === 3
    const xingAt = i + 4 + (mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17)
    if (xingAt + 12 <= buf.length) {
      const magic = ascii(buf, xingAt, 4)
      if (magic === 'Xing' || magic === 'Info') {
        const flags = u32be(buf, xingAt + 4)
        if (flags & 1) {
          const frames = u32be(buf, xingAt + 8)
          if (frames > 0) return (frames * perFrame) / sampleRate
        }
      }
    }
    const vbriAt = i + 4 + 32
    if (vbriAt + 20 <= buf.length && ascii(buf, vbriAt, 4) === 'VBRI') {
      const frames = u32be(buf, vbriAt + 14)
      if (frames > 0) return (frames * perFrame) / sampleRate
    }
    return ((file.size - audioStart) * 8) / (kbps * 1000)
  }
  return undefined
}

// ------------------------------------------------------------------ MP4/M4A

interface Atom {
  type: string
  body: number
  end: number
}

function* atoms(b: Uint8Array, start: number, end: number): Generator<Atom> {
  let p = start
  while (p + 8 <= end) {
    let size = u32be(b, p)
    let hdr = 8
    if (size === 1) {
      if (p + 16 > end) return
      size = u32be(b, p + 8) * 4294967296 + u32be(b, p + 12)
      hdr = 16
    } else if (size === 0) size = end - p
    if (size < hdr || p + size > end) return
    yield { type: ascii(b, p + 4, 4), body: p + hdr, end: p + size }
    p += size
  }
}

function findAtom(b: Uint8Array, start: number, end: number, type: string): Atom | null {
  for (const a of atoms(b, start, end)) if (a.type === type) return a
  return null
}

/** `data` atom payload: 4 bytes type indicator, 4 bytes locale, then the value. */
function ilstValue(b: Uint8Array, entry: Atom): { text?: string; int?: number } | null {
  const data = findAtom(b, entry.body, entry.end, 'data')
  if (!data || data.body + 8 > data.end) return null
  const kind = u32be(b, data.body) & 0xffffff
  const value = b.subarray(data.body + 8, data.end)
  if (kind === 21 || kind === 22) {
    if (value.length === 2) return { int: u16be(value, 0) }
    if (value.length === 1) return { int: value[0] }
    if (value.length === 4) return { int: u32be(value, 0) }
    return null
  }
  if (kind === 0 && value.length === 2) return { int: u16be(value, 0), text: utf8.decode(value) }
  return { text: utf8.decode(value) }
}

const MAX_MOOV = 4_000_000

async function readMp4(file: File, tags: TrackTags) {
  // walk only the top level over the file — `mdat` can be hundreds of MB
  let p = 0
  let moov: { body: number; size: number } | null = null
  for (let i = 0; i < 64 && p + 8 <= file.size; i++) {
    const h = await slice(file, p, 16)
    if (h.length < 8) break
    let size = u32be(h, 0)
    let hdr = 8
    if (size === 1) {
      if (h.length < 16) break
      size = u32be(h, 8) * 4294967296 + u32be(h, 12)
      hdr = 16
    } else if (size === 0) size = file.size - p
    if (size < hdr) break
    if (ascii(h, 4, 4) === 'moov') {
      moov = { body: p + hdr, size: size - hdr }
      break
    }
    p += size
  }
  if (!moov) return

  const b = await slice(file, moov.body, Math.min(moov.size, MAX_MOOV))
  const end = b.length

  const mvhd = findAtom(b, 0, end, 'mvhd')
  if (mvhd && mvhd.body + 24 <= mvhd.end) {
    const v = b[mvhd.body]
    const scale = v === 1 ? u32be(b, mvhd.body + 20) : u32be(b, mvhd.body + 12)
    const dur =
      v === 1
        ? u32be(b, mvhd.body + 24) * 4294967296 + u32be(b, mvhd.body + 28)
        : u32be(b, mvhd.body + 16)
    if (scale > 0 && dur > 0) tags.durationSec = dur / scale
  }

  const udta = findAtom(b, 0, end, 'udta')
  if (!udta) return
  const meta = findAtom(b, udta.body, udta.end, 'meta')
  if (!meta) return
  // `meta` is a full box: 4 bytes of version/flags before its children
  const ilst = findAtom(b, meta.body + 4, meta.end, 'ilst')
  if (!ilst) return

  for (const entry of atoms(b, ilst.body, ilst.end)) {
    if (entry.type === 'covr') continue
    if (entry.type === '----') {
      const nameAtom = findAtom(b, entry.body, entry.end, 'name')
      if (!nameAtom) continue
      const name = utf8.decode(b.subarray(nameAtom.body + 4, nameAtom.end)).toLowerCase()
      const v = ilstValue(b, entry)
      if (!v?.text) continue
      if (name === 'initialkey' || name === 'key') applyKey(tags, v.text)
      else if (name === 'bpm' || name === 'tempo') tags.bpm ??= bpmValue(v.text)
      else if (name.includes('autotags')) {
        const raw = fromBase64(v.text)
        if (raw) tags.bpm ??= seratoAutotagsBpm(raw)
      }
      continue
    }

    const v = ilstValue(b, entry)
    if (!v) continue
    switch (entry.type) {
      case 'tmpo':
        tags.bpm ??= bpmValue(v.int ?? v.text)
        break
      case '©ART':
      case 'aART':
        tags.artist ??= text(v.text)
        break
      case '©nam':
        tags.title ??= text(v.text)
        break
      case '©alb':
        tags.album ??= text(v.text)
        break
      case 'keyy':
        applyKey(tags, v.text)
        break
    }
  }
}

// --------------------------------------------------------- FLAC / OGG Vorbis

function parseVorbisComments(b: Uint8Array, start: number, tags: TrackTags) {
  let p = start
  if (p + 4 > b.length) return
  p += 4 + u32le(b, p) // vendor string
  if (p + 4 > b.length) return
  const count = u32le(b, p)
  p += 4
  for (let i = 0; i < count && p + 4 <= b.length; i++) {
    const len = u32le(b, p)
    p += 4
    if (len > b.length - p) return
    const entry = utf8.decode(b.subarray(p, p + len))
    p += len
    const eq = entry.indexOf('=')
    if (eq < 1) continue
    const field = entry.slice(0, eq).toUpperCase()
    const value = text(entry.slice(eq + 1))
    if (!value) continue
    switch (field) {
      case 'BPM':
      case 'TEMPO':
        tags.bpm ??= bpmValue(value)
        break
      case 'KEY':
      case 'INITIALKEY':
      case 'INITIAL_KEY':
        applyKey(tags, value)
        break
      case 'ARTIST':
        tags.artist ??= value
        break
      case 'TITLE':
        tags.title ??= value
        break
      case 'ALBUM':
        tags.album ??= value
        break
      case 'SERATO_AUTOTAGS': {
        const raw = fromBase64(value)
        if (raw) tags.bpm ??= seratoAutotagsBpm(raw)
        break
      }
    }
  }
}

async function readFlac(file: File, tags: TrackTags) {
  const b = await slice(file, 0, 1_000_000)
  if (b.length < 8 || ascii(b, 0, 4) !== 'fLaC') return
  let p = 4
  while (p + 4 <= b.length) {
    const last = b[p] & 0x80
    const type = b[p] & 0x7f
    const len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]
    const body = p + 4
    if (body + len > b.length) break
    if (type === 0 && len >= 18) {
      const sr = (b[body + 10] << 12) | (b[body + 11] << 4) | (b[body + 12] >> 4)
      const samples = (b[body + 12] & 0x0f) * 4294967296 + u32be(b, body + 13)
      if (sr > 0 && samples > 0) tags.durationSec = samples / sr
    } else if (type === 4) {
      parseVorbisComments(b, body, tags)
    }
    if (last) break
    p = body + len
  }
}

interface OggPage {
  payloadStart: number
  pageEnd: number
}

/**
 * Reads one Ogg page's framing (`OggS` + version/flags/granule/serial/
 * sequence/checksum, then an N-byte segment table whose sum is the payload
 * length) — just enough to find where a page's payload starts and ends,
 * not to reassemble multi-page packets. `null` on anything short or
 * malformed enough not to trust, same "degrade rather than guess" as the
 * rest of this file.
 */
function readOggPage(b: Uint8Array, p: number): OggPage | null {
  if (p + 27 > b.length || ascii(b, p, 4) !== 'OggS') return null
  const segCount = b[p + 26]
  const segTableStart = p + 27
  if (segTableStart + segCount > b.length) return null
  let payloadLen = 0
  for (let i = 0; i < segCount; i++) payloadLen += b[segTableStart + i]
  const payloadStart = segTableStart + segCount
  const pageEnd = payloadStart + payloadLen
  if (pageEnd > b.length) return null
  return { payloadStart, pageEnd }
}

/**
 * Best-effort OGG: the comment header is always the second page (the first
 * is the identification header) for any normally-tagged Vorbis/Opus file,
 * so this walks real Ogg page framing to reach it directly instead of
 * scanning raw bytes for the `\x03vorbis`/`OpusTags` signature — a blind
 * scan risks a false match inside the compressed audio payload of a later
 * page (pure chance, but a 256KB window is a lot of chances) landing on
 * page 1's signature check before ever reaching the real header, and
 * silently returning garbage instead of the actual tags. No real OGG file
 * exists in this environment to test this against — see
 * `tests/platform/tags.test.ts` for what synthetic coverage exists instead.
 */
async function readOgg(file: File, tags: TrackTags) {
  const b = await slice(file, 0, 262_144)
  const page0 = readOggPage(b, 0)
  if (!page0) return
  const page1 = readOggPage(b, page0.pageEnd)
  if (!page1) return
  const start = page1.payloadStart
  if (b[start] === 0x03 && ascii(b, start + 1, 6) === 'vorbis') {
    parseVorbisComments(b, start + 7, tags)
  } else if (b[start] === 0x4f && ascii(b, start, 8) === 'OpusTags') {
    parseVorbisComments(b, start + 8, tags)
  }
}

// ------------------------------------------------------------ RIFF / AIFF

/**
 * WAV (RIFF, little-endian) and AIFF (FORM, big-endian) share a chunk layout,
 * so one walker covers both. Duration comes from the format chunk; tags come
 * from an `ID3 ` chunk, which DJ software writes *after* the audio payload —
 * hence seeking chunk by chunk instead of reading a window off the front.
 */
// Every chunk costs at least an 8-byte header, so this bounds the walk to
// roughly a 32KB run of headers even on a pathological file — nowhere close
// to real WAV/AIFF files (a handful of top-level chunks), but high enough
// that a legitimate ID3 chunk sitting past the 64th chunk (the old cap —
// hit on a real file, v0.8.3 debt) is never missed again.
const MAX_CHUNKS = 4096

async function readChunked(file: File, tags: TrackTags, littleEndian: boolean) {
  const u32 = littleEndian ? u32le : u32be
  let byteRate = 0
  let p = 12

  for (let i = 0; i < MAX_CHUNKS && p + 8 <= file.size; i++) {
    const head = await slice(file, p, 8)
    if (head.length < 8) return
    const id = ascii(head, 0, 4)
    const size = u32(head, 4)
    const body = p + 8

    if (littleEndian && id === 'fmt ') {
      const fmt = await slice(file, body, 16)
      if (fmt.length >= 12) byteRate = u32le(fmt, 8)
    } else if (!littleEndian && id === 'COMM') {
      // AIFF: numSampleFrames (u32 BE) at +2, sample rate as an 80-bit float at +8
      const comm = await slice(file, body, 18)
      if (comm.length >= 18) {
        const frames = u32be(comm, 2)
        const exp = u16be(comm, 8) - 16383
        const mantissa = u32be(comm, 10) * 4294967296 + u32be(comm, 14)
        const sr = mantissa * Math.pow(2, exp - 63)
        if (frames > 0 && sr > 1000) tags.durationSec = frames / sr
      }
    } else if (littleEndian && id === 'data') {
      const bytes = size > 0 ? size : file.size - body
      if (byteRate > 0) tags.durationSec = bytes / byteRate
    } else if (id.toUpperCase() === 'ID3 ') {
      await readId3(file, body, tags)
    }

    // A zero-size chunk (padding some writers emit) used to abort the whole
    // walk here, which could strand a real ID3 chunk written after it
    // unread. Step past just the header and keep going; only a *negative*
    // size — impossible from an unsigned read — would mean truly corrupt
    // data worth stopping for, and u32/u32be never produce one.
    p = size > 0 ? body + size + (size & 1) : body
  }
}

// --------------------------------------------------------------------- entry

/**
 * YouTube's auto-generated artist channels tag every file `<Artist> - Topic`,
 * and a DJ library pulled from there carries the suffix into every row. It is
 * never part of the name, so it goes.
 */
function cleanArtist(raw: string): string | undefined {
  return text(raw.replace(/\s*-\s*Topic$/i, ''))
}

/**
 * Read whatever metadata the file already carries. Never throws — an
 * unreadable or exotic file just yields fewer fields.
 */
export async function readTags(file: File): Promise<TrackTags> {
  const tags: TrackTags = {}
  try {
    const magic = await slice(file, 0, 12)
    if (magic.length < 8) return tags

    if (ascii(magic, 0, 3) === 'ID3') {
      const tagSize = await readId3(file, 0, tags)
      if (tags.durationSec == null) tags.durationSec = await mp3Duration(file, tagSize)
    } else if (ascii(magic, 4, 4) === 'ftyp') {
      await readMp4(file, tags)
    } else if (ascii(magic, 0, 4) === 'fLaC') {
      await readFlac(file, tags)
    } else if (ascii(magic, 0, 4) === 'OggS') {
      await readOgg(file, tags)
    } else if (ascii(magic, 0, 4) === 'RIFF') {
      await readChunked(file, tags, true)
    } else if (ascii(magic, 0, 4) === 'FORM') {
      await readChunked(file, tags, false)
    } else if (magic[0] === 0xff && (magic[1] & 0xe0) === 0xe0) {
      tags.durationSec = await mp3Duration(file, 0)
    }
  } catch (err) {
    // A malformed header is not worth failing a library scan over, and stays
    // swallowed. A file that cannot be read is a different event and must not
    // ride out on the same catch.
    const name = (err as { name?: string } | null)?.name
    if (name === 'NotReadableError' || name === 'NotAllowedError' || name === 'NotFoundError') {
      tags.unreadable = true
    }
  }
  if (tags.durationSec != null && (!isFinite(tags.durationSec) || tags.durationSec <= 0)) {
    delete tags.durationSec
  }
  if (tags.artist) tags.artist = cleanArtist(tags.artist)
  return tags
}
