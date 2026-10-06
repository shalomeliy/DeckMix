import { rowBpm } from '@/core/constants'
import type { Track } from '@/core/types'

/**
 * Sortable library columns (v0.8.0). `key` sorts by the Camelot wheel
 * position, not the displayed string — the display alternates between
 * musical and Camelot spelling (`keyMode`, `Library.tsx`), but the wheel
 * order is the one ordering that means the same thing in either mode.
 */
export type SortKey = 'title' | 'artist' | 'genre' | 'type' | 'bpm' | 'key' | 'durationSec' | 'note' | 'lastPlayedAt'
export type SortDir = 'asc' | 'desc'

/** `8A` -> 16, `8B` -> 17 — wheel position first, then major/minor. `undefined` for anything that doesn't parse, same "goes last" treatment as a missing BPM. */
export function camelotOrder(camelot: string | undefined): number | undefined {
  const m = camelot ? /^(\d{1,2})([AB])$/.exec(camelot) : null
  if (!m) return undefined
  return Number(m[1]) * 2 + (m[2] === 'B' ? 1 : 0)
}

function sortValue(t: Track, key: SortKey): string | number | undefined {
  switch (key) {
    case 'title':
      return (t.title ?? t.name).toLowerCase()
    case 'artist':
      return t.artist?.toLowerCase()
    case 'genre':
      // `t.genre` is already the effective one (the owner's manual pick over the folder's name), the same value the column shows
      return t.genre?.toLowerCase()
    case 'type':
      // v0.9.36: the file type ("mp3", "wav"), the same text the column shows
      return t.kind.toLowerCase()
    case 'bpm':
      return rowBpm(t)
    case 'key':
      return camelotOrder(t.camelot)
    case 'durationSec':
      return t.durationSec
    case 'note':
      return t.note?.toLowerCase()
    case 'lastPlayedAt':
      return t.lastPlayedAt
  }
}

/**
 * `sortKey === null` returns `tracks` unchanged (scan order, today's
 * behaviour). A track missing the sorted value always sorts last, in
 * *both* directions — a track with no BPM is not "the fastest" just
 * because the column is sorted descending.
 *
 * Ties break by artist, then title (Shalom, 23/09). Without that, 20 tracks
 * at 128 BPM sat in scan order, which reads as no order at all. Both
 * tie-breaks are always A→Z, whatever the main column's direction, because
 * they are there to help find a name, not to rank one. A missing artist goes
 * last, the same rule as a missing main value.
 */
export function sortTracks(tracks: Track[], sortKey: SortKey | null, sortDir: SortDir): Track[] {
  if (!sortKey) return tracks
  const dir = sortDir === 'asc' ? 1 : -1
  return [...tracks].sort((a, b) => {
    const av = sortValue(a, sortKey)
    const bv = sortValue(b, sortKey)
    if (av == null && bv != null) return 1
    if (bv == null && av != null) return -1
    if (av != null && bv != null) {
      // Text columns use the tie-breaks' own comparison, so "Track 2" sorts
      // before "Track 10" whether the title is the main column or a tie-break.
      const c =
        typeof av === 'string' && typeof bv === 'string'
          ? av.localeCompare(bv, undefined, { sensitivity: 'base', numeric: true })
          : av < bv
            ? -1
            : av > bv
              ? 1
              : 0
      if (c !== 0) return c * dir
    }
    return compareNames(a.artist, b.artist) || compareNames(a.title ?? a.name, b.title ?? b.name)
  })
}

/**
 * `localeCompare` rather than `<`: the library mixes Hebrew and English
 * names, and "base" sensitivity lets "Avicii" and "avicii" tie instead of
 * splitting on case. `numeric` puts "Track 2" before "Track 10".
 */
function compareNames(a: string | undefined, b: string | undefined): number {
  const x = a?.trim() || undefined
  const y = b?.trim() || undefined
  if (x == null && y == null) return 0
  if (x == null) return 1
  if (y == null) return -1
  return x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true })
}
