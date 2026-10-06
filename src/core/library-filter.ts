import { rowBpm } from '@/core/constants'
import type { Track } from '@/core/types'

/**
 * The ▾ filters in the track list's column headers (v0.9.36, Shalom 06/10:
 * "add filtering to every other column"). Genre got the first one in v0.9.24
 * and keeps its own `genreFilter`; these are the rest, one entry per column,
 * all applied together (AND), and together with the search box.
 *
 * Each kind of column gets the filter its values call for:
 * - Title / Artist / Note: the text appears anywhere in the cell. Artist and
 *   Note can also be "empty only" or "hide empty" — a track without an artist
 *   is something to find, not only something to filter away.
 * - Type / Key: tick the values to keep, like Genre.
 * - BPM / Time: a from–to range, either end optional.
 * - Played: periods — never, last 24 hours, last 7 days, last 30 days, older.
 *
 * A range hides the tracks that have no value at all (no BPM yet, no length).
 * That is not silent: `missingCount` counts them and the ▾ list says so.
 */
export interface TextFilter {
  contains?: string
  /** `only`: just the empty cells; `hide`: just the filled ones. */
  blank?: 'only' | 'hide'
}

export interface NumberRange {
  min?: number
  max?: number
}

export type PlayedBucket = 'never' | 'day' | 'week' | 'month' | 'older'

export interface ColumnFilters {
  title?: TextFilter
  artist?: TextFilter
  note?: TextFilter
  /** `track.kind` values ("mp3", "wav"). */
  type?: string[]
  /** `keyValue(track)`; `''` is "no key". */
  key?: string[]
  bpm?: NumberRange
  /** Seconds. */
  durationSec?: NumberRange
  played?: PlayedBucket[]
}

export type FilterColumn = keyof ColumnFilters

export const PLAYED_BUCKETS: readonly PlayedBucket[] = ['never', 'day', 'week', 'month', 'older']

export const PLAYED_BUCKET_LABEL: Record<PlayedBucket, string> = {
  never: 'Never played',
  day: 'Last 24 hours',
  week: '1–7 days ago',
  month: '7–30 days ago',
  older: 'Over 30 days ago',
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The periods don't overlap, so each track sits in exactly one and the counts in the list add up to the library. */
export function playedBucket(lastPlayedAt: number | undefined, now: number): PlayedBucket {
  if (!lastPlayedAt) return 'never'
  const age = now - lastPlayedAt
  if (age < DAY_MS) return 'day'
  if (age < 7 * DAY_MS) return 'week'
  if (age < 30 * DAY_MS) return 'month'
  return 'older'
}

/** What the Key filter groups by: the Camelot code when known, so "Am" and "8A" are one line; the raw key otherwise; `''` for none. */
export function keyValue(t: Track): string {
  return t.camelot ?? t.key ?? ''
}

function matchesText(value: string | undefined, f: TextFilter): boolean {
  const v = value?.trim() ?? ''
  if (f.blank === 'only') return v === ''
  if (f.blank === 'hide' && v === '') return false
  const q = f.contains?.trim().toLowerCase()
  return !q || v.toLowerCase().includes(q)
}

function matchesRange(value: number | undefined, r: NumberRange): boolean {
  if (value == null) return false
  if (r.min != null && value < r.min) return false
  if (r.max != null && value > r.max) return false
  return true
}

/**
 * The track's value for a range column, `undefined` when it has none —
 * compared as the cell shows it: BPM rounded (130.4 reads "130" and belongs in
 * 120–130), the length cut to the second (450.6s reads "7:30" and belongs in
 * "up to 7:30"). The same rule as the BPM column search (`library-search.ts`).
 */
function rangeValue(t: Track, column: 'bpm' | 'durationSec'): number | undefined {
  const v = column === 'bpm' ? rowBpm(t) : t.durationSec
  if (v == null || !isFinite(v) || v <= 0) return undefined
  return column === 'bpm' ? Math.round(v) : Math.floor(v)
}

export function matchesColumnFilters(t: Track, f: ColumnFilters, now: number): boolean {
  if (f.title && !matchesText(t.title ?? t.name, f.title)) return false
  if (f.artist && !matchesText(t.artist, f.artist)) return false
  if (f.note && !matchesText(t.note, f.note)) return false
  if (f.type && !f.type.includes(t.kind)) return false
  if (f.key && !f.key.includes(keyValue(t))) return false
  if (f.bpm && !matchesRange(rangeValue(t, 'bpm'), f.bpm)) return false
  if (f.durationSec && !matchesRange(rangeValue(t, 'durationSec'), f.durationSec)) return false
  if (f.played && !f.played.includes(playedBucket(t.lastPlayedAt, now))) return false
  return true
}

/** Tracks a range on this column hides only because they have no value yet — said in the ▾ list, never left to guess. */
export function missingCount(tracks: readonly Track[], column: 'bpm' | 'durationSec'): number {
  let n = 0
  for (const t of tracks) if (rangeValue(t, column) == null) n++
  return n
}

/**
 * An empty filter is no filter: stored as absent, so a cleared box, an
 * all-unticked list or a range with both ends blank never leaves an empty
 * table that reads as a broken library (the same rule as `setGenreFilter`).
 */
export function normalizeFilter<C extends FilterColumn>(column: C, value: ColumnFilters[C] | null | undefined): ColumnFilters[C] | undefined {
  if (value == null) return undefined
  if (Array.isArray(value)) return (value.length > 0 ? value : undefined) as ColumnFilters[C]
  if (column === 'bpm' || column === 'durationSec') {
    const r = value as NumberRange
    const min = r.min != null && isFinite(r.min) ? r.min : undefined
    const max = r.max != null && isFinite(r.max) ? r.max : undefined
    if (min == null && max == null) return undefined
    // typed backwards ("130" to "120") means the same range, not an empty table
    return (min != null && max != null && min > max ? { min: max, max: min } : { min, max }) as ColumnFilters[C]
  }
  const t = value as TextFilter
  if (t.blank) return { blank: t.blank, ...(t.blank === 'hide' && t.contains?.trim() ? { contains: t.contains } : {}) } as ColumnFilters[C]
  return (t.contains?.trim() ? { contains: t.contains } : undefined) as ColumnFilters[C]
}

/**
 * "m:ss", "m" (whole minutes) or "m.5" — what the owner types in the Time
 * range. `undefined` for blank or unreadable, which the box then shows as
 * not applied instead of quietly reading as 0.
 */
export function parseTimeInput(raw: string): number | undefined {
  const s = raw.trim()
  if (!s) return undefined
  const m = /^(\d{1,3}):([0-5]?\d)$/.exec(s)
  if (m) return Number(m[1]) * 60 + Number(m[2])
  if (/^\d{1,3}(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60)
  return undefined
}

export function fmtMinSec(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export const FILTER_COLUMN_LABEL: Record<FilterColumn, string> = {
  title: 'Title',
  artist: 'Artist',
  note: 'Note',
  type: 'Type',
  key: 'Key',
  bpm: 'BPM',
  durationSec: 'Time',
  played: 'Played',
}

function describeRange(r: NumberRange, fmt: (n: number) => string): string {
  if (r.min != null && r.max != null) return `${fmt(r.min)}–${fmt(r.max)}`
  if (r.min != null) return `${fmt(r.min)} and up`
  return `up to ${fmt(r.max!)}`
}

/** The chip text for one active filter, e.g. `BPM: 120–130`, `Artist: empty`. */
export function describeColumnFilter<C extends FilterColumn>(column: C, value: NonNullable<ColumnFilters[C]>): string {
  const label = FILTER_COLUMN_LABEL[column]
  switch (column) {
    case 'title':
    case 'artist':
    case 'note': {
      const t = value as TextFilter
      if (t.blank === 'only') return `${label}: empty`
      const parts = [t.contains?.trim() ? `"${t.contains.trim()}"` : '', t.blank === 'hide' ? 'not empty' : ''].filter(Boolean)
      return `${label}: ${parts.join(', ')}`
    }
    case 'type':
      return `${label}: ${(value as string[]).map((k) => k.toUpperCase()).join(', ')}`
    case 'key':
      return `${label}: ${(value as string[]).map((k) => k || 'No key').join(', ')}`
    case 'bpm':
      return `${label}: ${describeRange(value as NumberRange, (n) => String(Math.round(n * 10) / 10))}`
    case 'durationSec':
      return `${label}: ${describeRange(value as NumberRange, fmtMinSec)}`
    case 'played':
      return `${label}: ${(value as PlayedBucket[]).map((b) => PLAYED_BUCKET_LABEL[b]).join(', ')}`
  }
  return label
}
