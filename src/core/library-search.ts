import { rowBpm } from '@/core/constants'
import type { Track } from '@/core/types'

/**
 * The library's free-text filter, extended with a BPM range (v0.8.0). A
 * plain query keeps matching exactly what `Library.tsx`'s search box
 * already matched (path/artist/title/genre substring) plus an exact key
 * match, so nothing that filtered before stops filtering now.
 *
 * `120-130` is read as a BPM range. A reversed range (`130-120`) or a
 * non-numeric one is not an error — the query just falls through to the
 * plain-text match below, same as any other string that happens to
 * contain a dash. Never a blocked or silently-empty result.
 */
export function matchesQuery(track: Track, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return true

  const range = parseBpmRange(q)
  if (range) {
    const bpm = rowBpm(track)
    return bpm != null && bpm >= range.min && bpm <= range.max
  }

  return (
    track.path.toLowerCase().includes(q) ||
    (track.artist?.toLowerCase().includes(q) ?? false) ||
    (track.title?.toLowerCase().includes(q) ?? false) ||
    (track.genre?.toLowerCase().includes(q) ?? false) ||
    track.key?.toLowerCase() === q ||
    track.camelot?.toLowerCase() === q
  )
}

/**
 * Columns the search box can be limited to (v0.8.25) — picked with the ⌕ in a
 * column header, shown as a "BPM ▸" tag in the box. What "matches" means is
 * different for each, and is written in the box itself (`columnSearchHint`):
 *
 * - Title / Artist: the typed text starts a word ("love" finds "Lovely Day"
 *   and "Endless Love", not "Glove").
 * - Genre: like Title and Artist — the typed text starts a word of the genre ("hou" finds House, "hop" finds Hip Hop).
 * - BPM: narrows from the first digit typed, the way the owner types it
 *   (24/09: "12" showed nothing, because it meant 11.5–12.5). The typed
 *   digits are the start of the BPM rounded to a whole number: "1" is
 *   100–199, "12" is 120–129, "128" is 127.5–128.5. With a dot ("128.5")
 *   the decimals count too. A range ("120-130") still works.
 * - Key: the start of either spelling — "8" finds 8A and 8B, "8A" or "Am"
 *   only that key. The two spellings can't collide (a Camelot code always
 *   starts with a digit, a note name never does).
 */
export type SearchColumn = 'title' | 'artist' | 'genre' | 'bpm' | 'key'

export const SEARCH_COLUMN_LABEL: Record<SearchColumn, string> = {
  title: 'Title',
  artist: 'Artist',
  genre: 'Genre',
  bpm: 'BPM',
  key: 'Key',
}

export function columnSearchHint(column: SearchColumn): string {
  switch (column) {
    case 'title':
      return 'start of a word in the title'
    case 'artist':
      return 'start of a word in the artist'
    case 'genre':
      return 'start of a word in the genre — hou → House'
    case 'bpm':
      return '12 → 120–129, 128 → 128, or 120-130'
    case 'key':
      return '8 → 8A and 8B, or 8A / Am'
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function startsAWord(field: string | undefined, q: string): boolean {
  if (!field) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(q)}`, 'iu').test(field)
}

/**
 * The one entry point for "does this track match this search" — the table,
 * a smart crate's refresh and its "may be stale" count all go through it.
 * Until v0.8.25's review a crate saved while a column tag was on re-ran the
 * plain search: "BPM ▸ 124" saved every track with "124" in its path.
 */
export function matchesSearch(track: Track, rawQuery: string, column: SearchColumn | null | undefined): boolean {
  return column ? matchesColumnQuery(track, column, rawQuery) : matchesQuery(track, rawQuery)
}

/** One track against a query limited to one column. An empty query matches everything, like the plain search. */
export function matchesColumnQuery(track: Track, column: SearchColumn, rawQuery: string): boolean {
  const q = rawQuery.trim()
  if (!q) return true
  switch (column) {
    case 'title':
      return startsAWord(track.title ?? track.name, q)
    case 'artist':
      return startsAWord(track.artist, q)
    case 'genre':
      // the genre the column shows (a manual pick over the folder name); a track with none never matches a genre search
      return startsAWord(track.genre, q)
    case 'bpm': {
      const bpm = rowBpm(track)
      if (bpm == null) return false
      const range = parseBpmRange(q)
      if (range) return bpm >= range.min && bpm <= range.max
      if (!/^\d+(\.\d*)?$/.test(q)) return false
      const dot = q.indexOf('.')
      const shown = dot < 0 ? String(Math.round(bpm)) : bpm.toFixed(Math.max(1, q.length - dot - 1))
      return shown.startsWith(q)
    }
    case 'key': {
      const k = q.toLowerCase()
      return (track.key?.toLowerCase().startsWith(k) ?? false) || (track.camelot?.toLowerCase().startsWith(k) ?? false)
    }
  }
}

export interface BpmRange {
  min: number
  max: number
}

/** `null` for anything that isn't a valid, non-reversed numeric range — the caller falls back to text matching, it never treats this as an error. */
export function parseBpmRange(q: string): BpmRange | null {
  const m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(q.trim())
  if (!m) return null
  const min = Number(m[1])
  const max = Number(m[2])
  if (!isFinite(min) || !isFinite(max) || min > max) return null
  return { min, max }
}
