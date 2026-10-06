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
 * v0.9.43: "left of the dash" was only true for the files that happened to be
 * checkable. Measured again on all 345 files (06/10), against the tags that
 * exist: Techno 24 right of the dash / 2 left ("Samsara - Anyma and Sevdaliza"),
 * HipHop 26 / 12, Mizrahi 18 / 1 — the side is a habit of the folder, and 11
 * files offered a song title as the artist. So the side is now decided by
 * votes (`sideVotes`); the unsure ones show both, never a silent pick.
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
  /** tracks with no artist at all, or only a wrong-looking one (`suspect`) */
  missing: number
  /** of those, with no hint anywhere — counted so they cannot vanish from view */
  noHint: number
  /** every track the view lists: no artist, or an artist tag that is a pack / remixer name */
  needs: Set<string>
  /** of `missing`, the ones that have a tag but a wrong-looking one */
  suspect: number
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


/** Words that make a piece of a name a version tag, never an artist. */
const VERSIONISH = /\b(remix|edit|mix|mashup|bootleg|rework|redrum|fix|intro|outro|extended|version|acapella|acap|cut|flip|dub|vip|ext)\s*$/i
const KEY_OR_BPM = /^\d{1,3}[ab]?$/i
const BRACKETS = /[([{][^)\]}]*[)\]}]?/g
/** A tag that is a pack, a site or a channel, not an artist — all seen in the owner's library (06/10). */
const JUNK_TAG = /teamix|\bwww\b|\.co\.il|\bvol\.?\s*\d|most popular|various artists|עולם הרמיקס/i

/** "A - B - C" outside brackets, with trailing key / BPM pieces ("- 2A - 100") dropped. */
function dashSegments(base: string): string[] {
  const out: string[] = []
  let rest = base
  for (;;) {
    const p = splitDash(rest)
    if (!p) break
    out.push(p.left)
    rest = p.right
  }
  out.push(rest)
  while (out.length > 1 && KEY_OR_BPM.test(out[out.length - 1].trim())) out.pop()
  return out
}

/** The right side as an artist, or null when it cannot be one (a version tag, or empty). */
function rightArtist(seg: string): string | null {
  const a = seg.replace(BRACKETS, ' ').replace(/\s+/g, ' ').trim()
  // "Baila Conmigo - ft Kelly Ruiz": a featuring credit is a continuation of the title, never an artist by itself
  if (!a || a.length > MAX_ARTIST_CHARS || !/\p{L}/u.test(a) || VERSIONISH.test(a) || /^(ft|feat|featuring|vs|x|with)\b/i.test(a)) return null
  return a
}

const CONTENT_SKIP = new Set(['and', 'x', 'ft', 'feat', 'vs', 'the', 'remix', 'edit', 'mix', 'intro', 'extended', 'original'])
const contentTokens = (s: string) => normalizeName(s).split(' ').filter((w) => w.length > 1 && !CONTENT_SKIP.has(w))

/** Where in the title tag a side of the file name sits: its first word's index, or -1 unless every word of it is there. */
function posIn(title: string[], side: string): number {
  const words = contentTokens(side)
  if (!words.length || !words.every((w) => title.includes(w))) return -1
  return Math.min(...words.map((w) => title.indexOf(w)))
}

/** An artist tag that is a pack / site name, or that is only a name inside the file name's brackets (the remixer). */
export function isJunkArtist(track: Track): boolean {
  const a = track.artist
  if (!a || track.artistSource === 'owner') return false
  if (JUNK_TAG.test(a)) return true
  const n = normalizeName(a)
  if (n.length < 4) return false
  const name = baseName(track.name)
  // "(feat. Drake)" in brackets is a credited artist, not the remixer
  const inBrackets = (name.match(BRACKETS) ?? []).filter((b) => !/^[([{]\s*(feat|ft|featuring|with)\b/i.test(b)).map(normalizeName).join(' | ')
  const outside = normalizeName(name.replace(BRACKETS, ' '))
  return (' ' + inBrackets + ' ').includes(' ' + n + ' ') && !(' ' + outside + ' ').includes(' ' + n + ' ')
}

/** Which side of the dash held the artist in the folder's tagged files: a habit, when it is lopsided enough. */
export type FolderHabit = Map<string, { left: number; right: number }>

const dirOf = (path: string) => path.split('/').slice(0, -1).join('/')

export function folderHabit(tagged: readonly Track[]): FolderHabit {
  const habit: FolderHabit = new Map()
  for (const t of tagged) {
    const segs = dashSegments(baseName(t.name))
    if (segs.length !== 2 || !t.artist) continue
    const mine = new Set([normalizeName(t.artist), ...artistPieces(t.artist)])
    const has = (side: string) => [normalizeName(side), ...artistPieces(side)].some((p) => mine.has(p))
    const l = has(segs[0])
    const r = has(segs[1])
    if (l === r) continue
    const e = habit.get(dirOf(t.path)) ?? { left: 0, right: 0 }
    if (l) e.left++
    else e.right++
    habit.set(dirOf(t.path), e)
  }
  return habit
}

interface Vote {
  side: 'L' | 'R'
  weight: number
  why: string
}

/**
 * The evidence for which side of "A - B" is the artist. Strong (2) evidence
 * decides alone; a lone weak (1) vote only reorders the two options.
 */
function sideVotes(track: Track, segs: string[], leftKnown: boolean, rightKnown: boolean, habit: FolderHabit | undefined): Vote[] {
  const votes: Vote[] = []
  const [left, right] = segs
  if (leftKnown) votes.push({ side: 'L', weight: 2, why: 'the left side is an artist you have' })
  if (rightKnown) votes.push({ side: 'R', weight: 2, why: 'the right side is an artist you have' })
  if (VERSIONISH.test(left.replace(BRACKETS, ' ').trim()))
    votes.push({ side: 'R', weight: 2, why: 'the left side ends like a version name' })
  else if (/[([{]/.test(left)) votes.push({ side: 'R', weight: 2, why: 'the left side has a version in brackets, so it is the title' })
  if (track.title) {
    const strip = (x: string) => x.replace(BRACKETS, ' ')
    // The title tag that reads "Artist - Song (…)": its first piece is the artist, whichever order the file name uses.
    const t0 = splitDash(baseName(track.title))?.left
    const first = t0 ? normalizeName(strip(t0)) : ''
    const l = normalizeName(strip(left))
    const r = normalizeName(strip(right))
    if (first && first === r && first !== l) votes.push({ side: 'R', weight: 2, why: 'the title tag starts with the right side' })
    else if (first && first === l && first !== r) votes.push({ side: 'L', weight: 2, why: 'the title tag starts with the left side' })
    else {
      const title = normalizeName(strip(track.title)).split(' ')
      const pl = posIn(title, strip(left))
      const pr = posIn(title, strip(right))
      if (pl >= 0 && pr < 0) votes.push({ side: 'R', weight: 2, why: 'the left side is inside the title tag' })
      else if (pr >= 0 && pl < 0) votes.push({ side: 'L', weight: 2, why: 'the right side is inside the title tag' })
    }
  }
  const h = habit?.get(dirOf(track.path))
  if (h && h.left + h.right >= 4) {
    const total = h.left + h.right
    const side = h.right > h.left ? 'R' : 'L'
    const share = Math.max(h.left, h.right) / total
    if (share >= 0.85) votes.push({ side, weight: share >= 0.9 && total >= 8 ? 2 : 1, why: `in this folder the artist is on the ${side === 'R' ? 'right' : 'left'} in ${Math.max(h.left, h.right)} of ${total} named files` })
  }
  const joiners = /\b(and|&|ft\.?|feat\.?|x|vs\.?)\b|,/i
  if (joiners.test(right) && !joiners.test(left)) votes.push({ side: 'R', weight: 1, why: 'the right side lists several names' })
  return votes
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
export function optionsFor(track: Track, known: Known, tagged: readonly Track[], habit?: FolderHabit): ArtistOption[] {
  const base = baseName(track.name)
  const out: ArtistOption[] = []
  const left = leftArtist(base)
  const knownHit = (a: string) => artistPieces(a).concat(normalizeName(a)).map((p) => known.pieces.get(p)).find(Boolean)
  const leftOpt = (reason?: string): ArtistOption | null => {
    if (!left) return null
    const hit = knownHit(left)
    return hit ? { artist: left, source: 'name-known', detail: `${hit.display} is on ${songsLabel(hit.count)}` } : { artist: left, source: 'name', detail: reason }
  }
  const segs = dashSegments(base)
  const rightName = segs.length === 2 ? rightArtist(segs[1]) : null
  if (rightName) {
    const rHit = knownHit(rightName)
    const votes = sideVotes(track, segs, !!(left && knownHit(left)), !!rHit, habit)
    const score = votes.reduce((n, v) => n + (v.side === 'R' ? v.weight : -v.weight), 0)
    const why = votes.filter((v) => v.side === 'R').map((v) => v.why)[0]
    const rightOpt: ArtistOption = rHit
      ? { artist: rightName, source: 'name-known', detail: `right of the dash: ${rHit.display} is on ${songsLabel(rHit.count)}` }
      : { artist: rightName, source: 'name', detail: `right of the dash: ${why ?? 'a guess'}` }
    const both = votes.some((v) => v.side === 'L') && votes.some((v) => v.side === 'R')
    const l = leftOpt()
    if (!l) {
      if (score >= 1) out.push(rightOpt)
    } else if (both) {
      out.push(...(score > 0 ? [rightOpt, l] : [l, rightOpt]))
    } else if (score >= 2 && votes.some((v) => v.side === 'R' && v.weight === 2)) out.push(rightOpt)
    else if (score >= 1) out.push(rightOpt, l)
    else out.push(l)
  } else {
    const l = leftOpt()
    if (l) out.push(l)
    else if (!splitDash(base)) {
      const n = ' ' + normalizeName(base) + ' '
      let best: { display: string; count: number; key: string } | null = null
      for (const [key, e] of known.pieces) {
        if (key.length < MIN_PREFIX_CHARS || !n.startsWith(' ' + key + ' ') || n.trim() === key) continue
        if (!best || key.length > best.key.length) best = { ...e, key }
      }
      if (best) out.push({ artist: best.display, source: 'known-prefix', detail: `on ${songsLabel(best.count)}` })
    }
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
  // A tag that is a pack or a remixer's name counts as no artist (v0.9.43): it is shown in the same view, with the file name's guess beside it.
  const junk = new Set(tracks.filter(isJunkArtist).map((t) => t.id))
  const tagged = tracks.filter((t) => t.artist && !junk.has(t.id))
  // "known" means the files say so. An artist the owner accepted from a file
  // name would otherwise promote that same guess on every other file to
  // "known", and into its "✓ all" (change-reviewer, 06/10).
  const trusted = tagged.filter((t) => t.artistSource !== 'owner')
  const known = knownArtists(trusted)
  const habit = folderHabit(trusted)
  const byTrack = new Map<string, ArtistOption[]>()
  const needs = new Set<string>()
  let noHint = 0
  for (const t of tracks) {
    if (t.artist && !junk.has(t.id)) continue
    needs.add(t.id)
    const no = new Set(rejected(t).map(normalizeName))
    if (t.artist) no.add(normalizeName(t.artist))
    const opts = optionsFor(t, known, tagged, habit).filter((o) => !no.has(normalizeName(o.artist)))
    if (opts.length) byTrack.set(t.id, opts)
    else noHint++
  }
  return { byTrack, missing: needs.size, noHint, needs, suspect: junk.size }
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
      return o.detail ? `from the file name · ${o.detail}` : 'from the file name'
    case 'pixabay':
      return 'Pixabay uploader'
  }
}
