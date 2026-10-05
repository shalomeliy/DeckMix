import type { Track } from '@/core/types'

/**
 * Finding the same song twice in the library (v0.8.45, widened in v0.9.24).
 *
 * Display only: nothing here touches a file. Three tiers, because they mean
 * different things to the owner:
 *  - `identical`: every file in the group has the same `contentHash` — the same
 *    bytes under two names. Certain.
 *  - `probable`: the same song and the same version (no remix/edit tag that
 *    differs) and a near-equal length, but the bytes differ — an MP3 and a WAV
 *    of one song. A guess, so the UI says "probably".
 *  - `version`: the same song by name, but a different remix/edit tag or a
 *    clearly different length — "(Dj Camelion Extended Remix)" next to
 *    "(Hasod Remix)". Not a copy to clean up; listed because the owner asked to
 *    see them side by side (05/10), each row saying what differs.
 *
 * "The same song" is decided on the name with the version tags taken out
 * (`songName`), and compared loosely (`sameSong`): word order, one extra word,
 * a spelling difference of a letter or two. v0.8.45 demanded the exact same
 * name and length, and the owner's two remixes of one song never met.
 *
 * `contentHash` and `durationSec` arrive lazily (scan → tag pass → analysis), so
 * a track can be uncomparable *yet*. Those are counted in `unchecked` rather
 * than dropped: a silent "no duplicates" while half the library is still
 * unidentified would be the same lie the "N skipped" badge exists to prevent.
 */

/** Two encodes of one song differ by encoder padding, rarely more than a second. */
export const DURATION_TOLERANCE_SEC = 1.5
/** A normalized name this short ("a", "01") would match unrelated files. */
const MIN_KEY_LENGTH = 4
/** Below this ratio two average bitrates are the same quality (VBR wobble, tag/artwork bytes). */
const QUALITY_RATIO = 1.2
/** Edit-distance similarity for "a letter or two apart" — צוחקת / צוחקות. */
const FUZZY_RATIO = 0.88
/**
 * A word in more names than this is no evidence two names are related ("the",
 * an artist with a whole folder), so it does not make them candidates. Only
 * the candidate search uses it — two names that do meet are still compared
 * on all their words.
 */
const COMMON_TOKEN = 40

export type DuplicateKind = 'identical' | 'probable' | 'version'

export interface DuplicateGroup {
  id: string
  kind: DuplicateKind
  /** track ids, in library order */
  trackIds: string[]
}

export interface DuplicateReport {
  groups: DuplicateGroup[]
  /** track id → its group, for the per-row tag */
  byTrack: Map<string, DuplicateGroup>
  /** tracks that cannot be compared yet: no content hash and no usable name+length */
  unchecked: number
}

/** "01 - Artist – Title (Mix).mp3" and "artist title mix" must meet. */
export function normalizeName(s: string): string {
  return s
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/^\s*\d{1,3}\s*[-._)]\s*/, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Words that say which cut of a song this is. Outside brackets they are pulled out of the name too. */
const VERSION_WORDS = new Set([
  'remix', 'rmx', 'mix', 'edit', 'extended', 'radio', 'club', 'dub', 'vip', 'bootleg', 'rework',
  'version', 'ver', 'live', 'acoustic', 'instrumental', 'remaster', 'remastered', 'mashup', 'reprise',
  'רמיקס', 'גרסה', 'מיקס', 'לייב',
])
/**
 * The few of those that never belong to a song's own title, so they are pulled
 * out even outside brackets ("Song Extended"). "Live", "Radio", "Club" are not
 * here: "Live Your Life" and "Radio Ga Ga" are titles.
 */
const LOOSE_VERSION_WORDS = new Set(['remix', 'rmx', 'extended', 'bootleg', 'rework', 'vip', 'remaster', 'remastered', 'mashup', 'רמיקס'])
/**
 * Words that sit in a file name without changing which recording it is. Taken
 * out of the version so "(Original Mix)" and no tag at all are the same
 * version, and "(Official Audio)" is not mistaken for a remix.
 */
const NOISE_WORDS = new Set([
  'original', 'official', 'audio', 'video', 'clip', 'lyrics', 'lyric', 'hq', 'hd', '4k', 'free', 'download',
  'kbps', 'mp3', 'wav', 'flac', 'explicit', 'music', 'prod', 'by', 'bpm', 'copy', 'קליפ', 'רשמי', 'מילים', 'עותק',
])
/**
 * A YouTube download carries its video id in brackets ("[0SDpEv8XuEM]"), and
 * Windows names a second copy "(1)" or "- Copy". Measured on the owner's
 * Music folder (05/10): without this, a downloaded twin of a song read as
 * "other mix", and two unrelated "YouTube [id].mp3" files read as one song.
 */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const isYoutubeId = (t: string) => YOUTUBE_ID.test(t) && !normalizeName(t).split(' ').some((w) => VERSION_WORDS.has(w))
const COPY_SUFFIX = /\s+-\s+(copy|עותק)\s*$/i
const BPM_TAG = /\b\d{2,3}\s*bpm\b/gi
const DOWNLOAD_SITE = /\byoutube\b/gi

interface NameParts {
  /** the song: artist + title words, version tags removed, normalized */
  song: string
  /** sorted words of the version tags, noise removed; '' for the plain/original version */
  version: string
  /** the version tags as the owner wrote them, for the notes */
  versionLabel: string
  /** words after the first " - " (the title, when the name is "Artist - Title"); all words when there is no dash */
  titleWords: number
}

/**
 * Splits "Artist feat. B - Title (Dj X Extended Remix) [VIP]" into the song
 * ("artist title") and its version ("dj x extended remix vip"). A featured
 * artist is dropped from both: one file often names them and its twin doesn't.
 */
export function songName(raw: string): NameParts {
  let s = raw.replace(/\.[a-z0-9]{2,5}$/i, '').replace(COPY_SUFFIX, '').replace(BPM_TAG, ' ').replace(DOWNLOAD_SITE, ' ')
  const tags: string[] = []
  s = s.replace(/[([{]([^)\]}]*)[)\]}]?/g, (_, inner: string) => {
    const t = inner.trim()
    if (!/^(feat|ft|featuring)\b/i.test(t) && !isYoutubeId(t) && !/^\d*$/.test(t)) tags.push(t)
    return ' '
  })
  // up to the next " - ", not the next hyphen: "feat. Jay-Z - Title" must not leave "z" behind
  s = s.replace(/\b(feat|ft|featuring)\b\.?(?:(?!\s[-–—]\s).)*/gi, ' ')
  // "Artist - Title - Extended Mix": a trailing dash part made of version words is a tag too
  // — but with only two parts the last one is usually the title ("Artist - Live Your Life"),
  // so there it must be made of nothing but version and noise words ("Radio Edit").
  const parts = s.split(/\s[-–—]\s/)
  if (parts.length >= 2) {
    const last = normalizeName(parts[parts.length - 1]).split(' ').filter(Boolean)
    const isTag =
      last.length > 0 &&
      (parts.length >= 3
        ? last.some((w) => VERSION_WORDS.has(w))
        : last.every((w) => VERSION_WORDS.has(w) || NOISE_WORDS.has(w)))
    if (isTag) tags.push(parts.pop()!.trim())
    s = parts.join(' - ')
  }
  const words = normalizeName(s).split(' ').filter(Boolean)
  // a bare "Extended" or "Remix" left in the title belongs to the version, not the song
  const songWords = words.filter((w) => !LOOSE_VERSION_WORDS.has(w))
  const loose = words.filter((w) => LOOSE_VERSION_WORDS.has(w))
  if (loose.length > 0) tags.push(loose.join(' '))
  let versionWords = normalizeName(tags.join(' ')).split(' ').filter((w) => w && !NOISE_WORDS.has(w) && !/^\d+$/.test(w))
  if (versionWords.length === 1 && versionWords[0] === 'mix') versionWords = []
  const title = parts.length >= 2 ? normalizeName(parts.slice(1).join(' ')).split(' ').filter((w) => w && !LOOSE_VERSION_WORDS.has(w)) : songWords
  return {
    song: songWords.join(' '),
    version: [...new Set(versionWords)].sort().join(' '),
    versionLabel: tags.filter((t) => normalizeName(t)).join(' · '),
    titleWords: title.length,
  }
}

interface SongKey {
  name: string
  words: ReadonlySet<string>
  titleWords: number
  /** this name carried a version tag — "Song Shimon Elbaz Extended Remix" is a remix credit, not a longer title */
  versioned: boolean
}

interface Keyed {
  /** the names this track can be known by: from its tags, and from its file name */
  songs: SongKey[]
  version: string
  versionLabel: string
}

/**
 * `findDuplicates` reruns on every library change — every tag batch during a
 * scan — and parsing names was half its cost, so a name is parsed once.
 */
const keyedCache = new Map<string, Keyed>()

function keyed(t: Track): Keyed {
  const cacheKey = `${t.name}\u0000${t.artist ?? ''}\u0000${t.title ?? ''}`
  const hit = keyedCache.get(cacheKey)
  if (hit) return hit
  const fromName = songName(t.name)
  const fromTags = t.artist && t.title ? songName(`${t.artist} - ${t.title}`) : null
  const songs: SongKey[] = []
  for (const p of [fromTags, fromName]) {
    if (!p || p.song.length < MIN_KEY_LENGTH || songs.some((k) => k.name === p.song)) continue
    songs.push({ name: p.song, words: new Set(p.song.split(' ')), titleWords: p.titleWords, versioned: p.version !== '' })
  }
  // the tags win, but a title tag without the remix in it must not hide the one in the file name
  const v = fromTags?.version ? fromTags : fromName
  const k = { songs, version: v.version, versionLabel: v.versionLabel }
  // a folder switch or a tag edit leaves old entries behind; a bound keeps that from growing forever
  if (keyedCache.size > 50_000) keyedCache.clear()
  keyedCache.set(cacheKey, k)
  return k
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * Two song names (already through `songName`) are one song when:
 *  - they hold the same words in any order ("A & B" / "B & A"),
 *  - one is the other plus one word, or plus two words when the shorter has two
 *    title words or the longer one carried a remix tag — and the shorter still
 *    has three words to be sure of (a two-word "Avicii Wake" must not swallow
 *    "Avicii Wake Me Up"). "Daft Punk - One" is not "Daft Punk - One More Time"
 *    (review, v0.9.24), but "Peer Tasi - Melody Shimon Elbaz Extended Remix" is
 *    "Peer Tasi - Melody", and "Nightshapes - Korolova and MotherEarth" is
 *    "Korolova, MotherEarth - Nightshapes" (both from the owner's library; the
 *    second names the title first, so "title words" can't be trusted alone),
 *  - or they are a letter or two apart (`FUZZY_RATIO`) — spelling, a typo.
 * Never when both carry numbers and the numbers differ: "Part 1" / "Part 2",
 * "Loop 01" … "Loop 120" — a letter apart, a whole song apart (review, v0.9.24:
 * 120 loops became one group). One side with no number at all ("Song 2", a
 * second copy) still meets.
 */
export function sameSong(a: string, b: string): boolean {
  const k = (s: string): SongKey => ({ name: s, words: new Set(s.split(' ')), titleWords: s.split(' ').length, versioned: false })
  return sameWords(k(a), k(b))
}

const numbers = (w: ReadonlySet<string>) => [...w].filter((x) => /^\d+$/.test(x)).map(Number)

function sameWords(ka: SongKey, kb: SongKey): boolean {
  const a = ka.name
  const b = kb.name
  if (a === b) return true
  const na = numbers(ka.words)
  const nb = numbers(kb.words)
  if (na.length > 0 && nb.length > 0 && (na.length !== nb.length || na.some((n) => !nb.includes(n)))) return false
  const [ks, kl] = ka.words.size <= kb.words.size ? [ka, kb] : [kb, ka]
  const small = ks.words
  const large = kl.words
  const contained = [...small].every((w) => large.has(w))
  if (contained && small.size === large.size) return true
  const extra = large.size - small.size
  if (contained && small.size >= 3 && (extra <= 1 || (extra <= 2 && (ks.titleWords >= 2 || kl.versioned)))) return true
  const longest = Math.max(a.length, b.length)
  if (Math.min(a.length, b.length) < 8) return false
  // the edit distance is at least the length difference — skip the O(n·m) when that alone fails
  const maxEdits = (1 - FUZZY_RATIO) * longest
  if (longest - Math.min(a.length, b.length) > maxEdits) return false
  // and at least one edit per word of one name that the other lacks
  let missing = 0
  for (const w of small) if (!large.has(w) && ++missing > maxEdits) return false
  return 1 - levenshtein(a, b) / longest >= FUZZY_RATIO
}

/**
 * Verdicts kept across calls: the table recomputes on every tag batch and every
 * analysed track, and the names rarely change between them. The review measured
 * ~100ms per call at 1,000 tracks without it.
 */
const pairCache = new Map<string, boolean>()
function samePair(a: SongKey, b: SongKey): boolean {
  const key = a.name < b.name ? `${a.name}\u0001${b.name}` : `${b.name}\u0001${a.name}`
  let v = pairCache.get(key)
  if (v === undefined) {
    if (pairCache.size > 200_000) pairCache.clear()
    v = sameWords(a, b)
    pairCache.set(key, v)
  }
  return v
}

export function findDuplicates(tracks: readonly Track[]): DuplicateReport {
  // union-find over track indexes, so a hash match and a name match that
  // overlap on one track end up in a single group
  const parent = tracks.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b)
  }

  const byHash = new Map<string, number>()
  tracks.forEach((t, i) => {
    if (!t.contentHash) return
    const first = byHash.get(t.contentHash)
    if (first === undefined) byHash.set(t.contentHash, i)
    else union(first, i)
  })

  // Comparing every pair is ~n²/2 edit distances on every library change; only
  // names that share a word can be one song, so only those are compared.
  const keys = tracks.map((t) => (t.durationSec === undefined ? null : keyed(t)))
  const postings = new Map<string, number[]>()
  keys.forEach((k, i) => {
    if (!k) return
    for (const w of new Set(k.songs.flatMap((s) => [...s.words]))) {
      const list = postings.get(w)
      if (list) list.push(i)
      else postings.set(w, [i])
    }
  })
  const tried = new Set<number>()
  for (const list of postings.values()) {
    if (list.length < 2 || list.length > COMMON_TOKEN) continue
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const i = list[x]
        const j = list[y]
        const pair = i * tracks.length + j
        if (tried.has(pair)) continue
        tried.add(pair)
        if (find(i) === find(j)) continue
        const a = keys[i]!
        const b = keys[j]!
        if (a.songs.some((s) => b.songs.some((r) => samePair(s, r)))) union(i, j)
      }
    }
  }

  const members = new Map<number, number[]>()
  tracks.forEach((_, i) => {
    const root = find(i)
    const list = members.get(root)
    if (list) list.push(i)
    else members.set(root, [i])
  })

  const groups: DuplicateGroup[] = []
  const byTrack = new Map<string, DuplicateGroup>()
  for (const idxs of members.values()) {
    if (idxs.length < 2) continue
    const group: DuplicateGroup = {
      id: tracks[idxs[0]].id,
      kind: groupKind(idxs.map((i) => tracks[i])),
      trackIds: idxs.map((i) => tracks[i].id),
    }
    groups.push(group)
    for (const id of group.trackIds) byTrack.set(id, group)
  }

  const unchecked = tracks.filter(
    (t, i) => !t.contentHash && (!keys[i] || keys[i]!.songs.length === 0),
  ).length
  return { groups, byTrack, unchecked }
}

function groupKind(ts: readonly Track[]): DuplicateKind {
  const h = ts[0].contentHash
  if (h !== undefined && ts.every((t) => t.contentHash === h)) return 'identical'
  // A hash twin can sit in the group without a name or length of its own (it
  // joined by bytes); it is the same recording as its twin, so only the
  // members that carry a name speak for the version.
  const named = ts.filter((t) => t.durationSec !== undefined)
  const versions = new Set(named.map((t) => keyed(t).version))
  const lens = named.map((t) => t.durationSec!)
  const spread = lens.length ? Math.max(...lens) - Math.min(...lens) : 0
  return versions.size <= 1 && spread <= DURATION_TOLERANCE_SEC ? 'probable' : 'version'
}

// ------------------------------------------------------------------- notes

const LOSSLESS = new Set(['wav', 'flac', 'aif', 'aiff'])

/** Average bitrate from size and length, or Infinity for a lossless file; null when unknown. */
function qualityOf(t: Track): number | null {
  if (LOSSLESS.has(t.kind)) return Infinity
  if (!t.sizeBytes || !t.durationSec) return null
  return (t.sizeBytes * 8) / t.durationSec / 1000
}

export function formatQuality(t: Track): string | null {
  const q = qualityOf(t)
  if (q === null) return null
  const fmt = t.kind.toUpperCase()
  return q === Infinity ? `${fmt} (lossless)` : `${fmt} ~${Math.round(q)} kbps`
}

function formatLength(sec: number): string {
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export interface DuplicateNote {
  /** two or three words for the row chip: "other mix · longer · lower quality" */
  short: string[]
  /** the whole comparison, one line per file, for the tooltip */
  detail: string
}

/**
 * What sets this track apart from the rest of its group — the "why is this
 * listed" the owner asked for (05/10). Relative to the group, so a pair reads
 * "longer" on one row and "shorter" on the other. A fact that is not known yet
 * (no size read, no length) says nothing rather than guessing.
 */
export function describeDuplicate(track: Track, group: DuplicateGroup, all: ReadonlyMap<string, Track>): DuplicateNote {
  const ts = group.trackIds.map((id) => all.get(id)).filter((t): t is Track => !!t)
  const others = ts.filter((t) => t.id !== track.id)
  const short: string[] = []
  // A group can hold two byte-identical files *and* a remix (review, v0.9.24):
  // the copies must still say so, or the one thing worth cleaning up reads as
  // "not a copy".
  const twins = track.contentHash ? others.filter((o) => o.contentHash === track.contentHash) : []
  if (group.kind === 'identical' || twins.length > 0) short.push('same file')
  if (group.kind !== 'identical') {
    const mine = keyed(track)
    if (others.some((o) => keyed(o).version !== mine.version)) short.push(mine.versionLabel ? 'other mix' : 'plain version')

    const lens = ts.map((t) => t.durationSec).filter((d): d is number => d !== undefined)
    if (track.durationSec !== undefined && lens.length > 1 && Math.max(...lens) - Math.min(...lens) > DURATION_TOLERANCE_SEC) {
      if (track.durationSec === Math.max(...lens)) short.push(ts.length === 2 ? 'longer' : 'longest')
      else if (track.durationSec === Math.min(...lens)) short.push(ts.length === 2 ? 'shorter' : 'shortest')
    }

    const q = qualityOf(track)
    const qs = ts.map(qualityOf).filter((v): v is number => v !== null)
    if (q !== null && qs.length > 1) {
      const best = Math.max(...qs)
      const worst = Math.min(...qs)
      if (best === Infinity ? worst !== Infinity : best / worst >= QUALITY_RATIO) {
        if (q === best) short.push('best quality')
        else if (q === Infinity ? false : best === Infinity || best / q >= QUALITY_RATIO) short.push('lower quality')
      }
    }
  }

  const head =
    group.kind === 'identical'
      ? `Identical file content: ${ts.length} copies in the library.`
      : group.kind === 'probable'
        ? `Probably the same song, same version: ${ts.length} files whose audio differs (e.g. MP3 and WAV).`
        : `The same song in ${ts.length} versions — a different mix or length; listed so you can compare.`
  const copies = group.kind === 'identical' ? [] : identicalSets(ts)
  const copyLine = copies.length
    ? `Byte-for-byte copies among them: ${copies.map((c) => c.map((t) => t.name).join(' = ')).join('; ')}.`
    : ''
  const lines = ts.map((t) => {
    const facts = [
      t.durationSec !== undefined ? formatLength(t.durationSec) : 'length unknown yet',
      formatQuality(t) ?? `${t.kind.toUpperCase()}, quality unknown yet`,
      keyed(t).versionLabel || 'no mix tag',
    ]
    return `${t.id === track.id ? '▶ ' : '• '}${t.name} — ${facts.join(' · ')}`
  })
  const qualityNote = ts.some((t) => !LOSSLESS.has(t.kind) && qualityOf(t) !== null)
    ? 'kbps is estimated from file size and length; cover art inside the file adds to it.'
    : ''
  return { short, detail: [head, copyLine, ...lines, qualityNote].filter(Boolean).join('\n') }
}

/** Sets of two or more files in `ts` with the same content hash. */
export function identicalSets(ts: readonly Track[]): Track[][] {
  const by = new Map<string, Track[]>()
  for (const t of ts) if (t.contentHash) by.set(t.contentHash, [...(by.get(t.contentHash) ?? []), t])
  return [...by.values()].filter((g) => g.length > 1)
}
