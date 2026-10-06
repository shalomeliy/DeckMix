import type { Track } from '@/core/types'
import { normalizeName, sameSong, songName } from '@/core/duplicates'

/**
 * Suggesting an artist for a track whose file carries none (v0.9.41).
 *
 * Measured on the owner's library before any of this was written (06/10): 217
 * of 378 tracks had no artist. The tag fields the reader skips (TPE2, TCOM,
 * aART…) were tried first and held no artist at all: 31 × "Dj Camelion" (the
 * remix pack), "TeaMix Hip Hop 8", site names. So nothing here reads tags.
 * What does carry the artist is the file name, "Artist - Title (Remix)": where
 * the left side could be checked against an artist already in the library it
 * was the artist 61 times out of 62, Hebrew included.
 *
 * Only ever a suggestion. Each one names where it came from, the owner accepts
 * or rejects it, and nothing is written to his files. A name that appears only
 * inside brackets is never offered: in the owner's names that is always the
 * remixer ("(Buskilaz Remix)"), 16 times out of 16.
 */

export type ArtistSource =
  /** left of the dash, and an artist the library already has */
  | 'name-known'
  /** the file name starts with an artist the library already has, no dash */
  | 'known-prefix'
  /** the same song in another file of his, which has an artist */
  | 'same-song'
  /** left of the dash, not known to the library — the one the owner checks */
  | 'name'
  /** Pixabay's "uploader-title-123456" download name */
  | 'pixabay'

export interface ArtistOption {
  artist: string
  source: ArtistSource
  /** what the label says beside it — the known artist's song count, the other file's name */
  detail?: string
}

export interface ArtistSuggestions {
  /** trackId → options, best first; only tracks with no artist and at least one option */
  byTrack: Map<string, ArtistOption[]>
  /** tracks with no artist at all */
  missing: number
  /** of those, with no hint anywhere — counted so they cannot vanish from view */
  noHint: number
}

/**
 * "Artist" this long is a sentence, not a name. The owner's longest real
 * credit is 84 ("Clean Bandit Ft. Sean Paul & Anne Marie vs. Henry Fong Vs.
 * Caroline D_Amore"): an earlier 60 left it and two like it with no hint.
 */
const MAX_ARTIST_CHARS = 100
/** A known artist this short ("dj", "mc") would match the start of unrelated names. */
const MIN_PREFIX_CHARS = 4

const EXTENSION = /(\.[a-z0-9]{2,5})+$/i
const TRACK_NUMBER = /^\s*\d{1,3}\s*[-._)]\s*/
/**
 * Invisible direction marks Windows and copy-paste leave at the start of a
 * Hebrew name ("\u200Eאושר כהן", "\u200E\u2068עומר אדם") — six of the owner's
 * files, and two more whose marks arrive as U+FFFD. Kept, they made the
 * suggestion a different string from the artist it is.
 */
const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ufffd]/g
/** Windows' second copy of a file: "עותק של …", "Copy of …" — never part of the artist. */
const COPY_OF = /^(?:עותק של|copy of)\s+/i
/** Download-site and pack labels the owner's names carry: "[VIP Djs]", "[www.slider.kz]", "- 128 BPM". */
const LABELS = /\[[^\]]*\]|\s+-\s+\d{2,3}\s*bpm\s*$|\b\d{2,3}\s*bpm\b/gi
const PIXABAY = /^([a-z][a-z0-9_]*)-[a-z0-9-]+-(\d{5,7})$/
const HEBREW = /[֐-׿]/

/** The file's own name, cleaned of what is never part of artist or title. */
export function baseName(name: string): string {
  return name
    .replace(BIDI_MARKS, '')
    .replace(EXTENSION, '')
    .replace(TRACK_NUMBER, '')
    .replace(/_/g, ' ')
    .trim()
    .replace(COPY_OF, '')
    .replace(LABELS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Index of the dash that splits "Artist - Title", outside any bracket, or -1.
 * " - " always; "Name- Title" too ("Noa Kirel- Pantera"); a bare hyphen only
 * between two Hebrew words and only when it is the name's one hyphen
 * ("עידו שהם-זאנזיבר") — in Latin names a bare hyphen is part of the name:
 * "Jay-Z", "Charly-Black-Party-Animal".
 */
function splitDash(s: string): { left: string; right: string } | null {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0 && /[-–—]/.test(c)) {
      const before = s[i - 1] ?? ''
      const after = s[i + 1] ?? ''
      const spaced = after === ' ' && i > 0
      const hebrewBare =
        before !== ' ' && after !== ' ' && HEBREW.test(before) && HEBREW.test(after) && (s.match(/-/g) ?? []).length === 1
      if (spaced || hebrewBare) return { left: s.slice(0, i).trim(), right: s.slice(i + 1).trim() }
    }
  }
  return null
}

/** Pieces of "A ft. B & C x D, E" — what "is this a known artist" compares. */
export function artistPieces(artist: string): string[] {
  return artist
    .split(/\s*(?:,|&|\+|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b|\bvs\.?|\band\b)\s*/i)
    .map(normalizeName)
    .filter((p) => p.length >= 3)
}

/** The left side of the dash, when it can be an artist at all. */
function leftArtist(base: string): string | null {
  const parts = splitDash(base)
  if (!parts) return null
  const left = parts.left.trim()
  // "Baroleta - (Dor Orpeli Edit)": the right side is only a version tag, so the left is the title.
  const right = parts.right.replace(/[([{][^)\]}]*[)\]}]?/g, ' ').replace(/\b\d+[ab]?\b/gi, ' ').trim()
  if (!right) return null
  // "A Milli Humble (Or Pilo BlackFix) - 1A - 150": a bracket on the left means the left is a title with its version.
  if (/[([{]/.test(left)) return null
  if (!left || left.length > MAX_ARTIST_CHARS || !/\p{L}/u.test(left)) return null
  return left
}

interface Known {
  /** normalized artist piece → how the library writes it, and on how many tracks */
  pieces: Map<string, { display: string; count: number }>
}

function knownArtists(tracks: readonly Track[]): Known {
  const pieces = new Map<string, { display: string; count: number }>()
  for (const t of tracks) {
    if (!t.artist) continue
    // The whole credit too, so "Offer Nissim, Maya Simantov" is known as written.
    const whole = normalizeName(t.artist)
    for (const p of new Set([whole, ...artistPieces(t.artist)])) {
      const e = pieces.get(p)
      if (e) e.count++
      else pieces.set(p, { display: p === whole ? t.artist : displayPiece(t.artist, p), count: 1 })
    }
  }
  return { pieces }
}

/** The piece as the tag spells it ("Nicki Minaj"), not normalized ("nicki minaj"). */
function displayPiece(artist: string, piece: string): string {
  const raw = artist.split(/\s*(?:,|&|\+|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b|\bvs\.?|\band\b)\s*/i)
  return raw.find((r) => normalizeName(r) === piece)?.trim() ?? piece
}

const songsLabel = (n: number) => (n === 1 ? '1 other song' : `${n} other songs`)

/** Options for one track, best first. Exported for the tests; the app calls `suggestArtists`. */
export function optionsFor(track: Track, known: Known, tagged: readonly Track[]): ArtistOption[] {
  const base = baseName(track.name)
  const out: ArtistOption[] = []
  const left = leftArtist(base)
  if (left) {
    const hit = artistPieces(left).concat(normalizeName(left)).map((p) => known.pieces.get(p)).find(Boolean)
    out.push(
      hit
        ? { artist: left, source: 'name-known', detail: `${hit.display} is on ${songsLabel(hit.count)}` }
        : { artist: left, source: 'name' },
    )
  } else if (!splitDash(base)) {
    const n = ' ' + normalizeName(base) + ' '
    let best: { display: string; count: number; key: string } | null = null
    for (const [key, e] of known.pieces) {
      if (key.length < MIN_PREFIX_CHARS || !n.startsWith(' ' + key + ' ') || n.trim() === key) continue
      if (!best || key.length > best.key.length) best = { ...e, key }
    }
    if (best) out.push({ artist: best.display, source: 'known-prefix', detail: `on ${songsLabel(best.count)}` })
  }
  const pix = PIXABAY.exec(track.name.replace(EXTENSION, ''))
  if (pix) out.push({ artist: pix[1].replace(/_/g, ' '), source: 'pixabay' })

  const key = songName(track.title ?? base).song
  if (key) {
    const twin = tagged.find((t) => t.id !== track.id && sameSong(songName(t.title ?? baseName(t.name)).song, key))
    if (twin?.artist) out.push({ artist: twin.artist, source: 'same-song', detail: twin.name })
  }
  // One answer from two sources is one option (the better-ranked one); two different answers are both shown.
  const seen = new Set<string>()
  return out.filter((o) => {
    const k = normalizeName(o.artist)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Suggestions for every track with no artist. `rejected` is what the owner
 * already said no to, per track — never offered again.
 */
export function suggestArtists(tracks: readonly Track[], rejected: (t: Track) => readonly string[] = (t) => t.artistRejected ?? []): ArtistSuggestions {
  const tagged = tracks.filter((t) => t.artist)
  const known = knownArtists(tagged)
  const byTrack = new Map<string, ArtistOption[]>()
  let missing = 0
  let noHint = 0
  for (const t of tracks) {
    if (t.artist) continue
    missing++
    const no = new Set(rejected(t).map(normalizeName))
    const opts = optionsFor(t, known, tagged).filter((o) => !no.has(normalizeName(o.artist)))
    if (opts.length) byTrack.set(t.id, opts)
    else noHint++
  }
  return { byTrack, missing, noHint }
}

/** What the label beside a suggestion says, in the owner's words. */
export function sourceLabel(o: ArtistOption): string {
  switch (o.source) {
    case 'name-known':
      return `from the file name · ${o.detail}`
    case 'known-prefix':
      return `artist you have · ${o.detail}`
    case 'same-song':
      return `same song in "${o.detail}"`
    case 'name':
      return 'from the file name'
    case 'pixabay':
      return 'Pixabay uploader'
  }
}
