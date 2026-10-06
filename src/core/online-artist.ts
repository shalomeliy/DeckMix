import type { ArtistOption } from '@/core/artist-suggest'
import { baseName } from '@/core/artist-suggest'
import { normalizeName } from '@/core/duplicates'
import type { OnlineHit } from '@/core/ports/artist-lookup'
import type { Track } from '@/core/types'

const BRACKETS = /[([{][^)\]}]*[)\]}]?/g
const MAX_ANSWERS = 3

/** Trance rows (owner, 06/10): their names are uploader slugs or edits, so a web search finds nobody — no button there. */
export const NO_LOOKUP_GENRE = 'Trance'
export const canLookUp = (t: Pick<Track, 'genre'>) => t.genre !== NO_LOOKUP_GENRE

const strip = (s: string) => normalizeName(s.replace(BRACKETS, ' '))

/** The song name to search for: the file name without brackets (versions, remixers) and without a trailing key / BPM piece. */
export function lookupTerm(track: Pick<Track, 'name'>): string {
  return baseName(track.name)
    .replace(BRACKETS, ' ')
    .replace(/\s+-\s+\d{1,3}[ab]?(\s+-\s+\d{2,3})?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The artists worth showing for what the store answered. A hit counts only when its
 * song name IS the name we searched (whole, or one side of a dash): a store returns
 * dozens of covers and look-alikes for a short title, and showing them all would
 * pass a guess off as a finding. Most frequent artist first; at most three.
 */
export function onlineOptions(term: string, hits: readonly OnlineHit[], rejected: readonly string[] = []): ArtistOption[] {
  const wanted = new Set([strip(term), ...term.split(/\s+-\s+/).map(strip)].filter((w) => w.length >= 2))
  const no = new Set(rejected.map(normalizeName))
  const byArtist = new Map<string, { artist: string; track: string; count: number }>()
  for (const h of hits) {
    if (!wanted.has(strip(h.track))) continue
    const key = normalizeName(h.artist)
    if (!key || no.has(key)) continue
    const e = byArtist.get(key)
    if (e) e.count++
    else byArtist.set(key, { artist: h.artist, track: h.track, count: 1 })
  }
  return [...byArtist.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_ANSWERS)
    .map((e) => ({ artist: e.artist, source: 'online' as const, detail: `"${e.track}", ${e.count === 1 ? '1 listing' : `${e.count} listings`}` }))
}
