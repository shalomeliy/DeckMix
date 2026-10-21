/**
 * Several remembered mix-in points per pair (v0.9.68 experiment).
 *
 * Until now a pair (`fromHash` → `toHash`) kept one point, and rating the same pair
 * "excellent" again overwrote it, so a second good entry destroyed the first. The pair
 * record keeps its old `entrySec`/`exitSec` fields (the latest point, which `recommend.ts`
 * and the strip still read) and gains `entries`, the whole list. A record written before this
 * has no `entries`: it counts as a list of one, built from those two fields, so nothing
 * Shalom already rated is lost.
 */

export interface PairEntry {
  entrySec: number
  /** Where the outgoing deck was at the join. Absent on pairs saved before v0.8.16. */
  exitSec?: number
  /** `Date.now()` when rated */
  at: number
}

/** Two entries closer than this are the same mix-in point rated twice (the candidate finder never repeats a float). */
export const SAME_ENTRY_WINDOW_SEC = 8

/** A pair cannot grow without bound; the oldest goes first, and the caller says so. */
export const MAX_ENTRIES_PER_PAIR = 12

/** The list a stored pair stands for, old or new format. */
export function entriesOf(rec: { entrySec: number; exitSec?: number; entries?: PairEntry[] }): PairEntry[] {
  if (rec.entries && rec.entries.length > 0) return rec.entries
  return [{ entrySec: rec.entrySec, exitSec: rec.exitSec, at: 0 }]
}

/**
 * Adds one rated entry. Within `SAME_ENTRY_WINDOW_SEC` of an existing one it replaces that entry (a
 * re-rating of the same point updates its exit second), otherwise it is appended. `dropped` is true when
 * the cap pushed the oldest entry out, so the caller can show it instead of losing it silently.
 */
export function addPairEntry(
  existing: PairEntry[],
  next: PairEntry,
): { entries: PairEntry[]; dropped: boolean } {
  const i = existing.findIndex((e) => Math.abs(e.entrySec - next.entrySec) < SAME_ENTRY_WINDOW_SEC)
  if (i >= 0) {
    const copy = existing.slice()
    copy[i] = next
    return { entries: copy, dropped: false }
  }
  const all = [...existing, next]
  if (all.length <= MAX_ENTRIES_PER_PAIR) return { entries: all, dropped: false }
  const oldest = all.reduce((o, e, k) => (e.at < all[o].at ? k : o), 0)
  return { entries: all.filter((_, k) => k !== oldest), dropped: true }
}

export interface PairRow {
  fromHash: string
  toHash: string
  entries: PairEntry[]
}

export interface PairTotals {
  /** every remembered pair, each (from, to) once */
  pairs: number
  /** how many of them hold two or more different points: the experiment's pass number */
  withMultiple: number
  /** every point of every pair */
  points: number
}

/** The one number the v0.9.68 experiment is judged by, computed the same way the console line did. */
export function pairTotals(rows: readonly PairRow[]): PairTotals {
  return {
    pairs: rows.length,
    withMultiple: rows.filter((r) => r.entries.length > 1).length,
    points: rows.reduce((n, r) => n + r.entries.length, 0),
  }
}

/** Flattens stored records (`fromHash` -> follow-ups, old or new format) into one row per pair, most points first. */
export function pairRows(
  stored: readonly { fromHash: string; followUps: readonly { toHash: string; entrySec: number; exitSec?: number; entries?: PairEntry[] }[] }[],
): PairRow[] {
  return stored
    .flatMap((rec) => rec.followUps.map((f) => ({ fromHash: rec.fromHash, toHash: f.toHash, entries: entriesOf(f) })))
    .sort((a, b) => b.entries.length - a.entries.length)
}


/** v0.12.15: a point is the one already saved as Excellent when it falls within `windowSec` of a saved entry. */
export function hasEntryNear(entries: readonly PairEntry[], entrySec: number, windowSec: number): boolean {
  return entries.some((e) => Math.abs(e.entrySec - entrySec) < windowSec)
}

/** The owner's "remove Excellent": drops the entries at that point. */
export function removeEntriesNear(entries: readonly PairEntry[], entrySec: number, windowSec: number): PairEntry[] {
  return entries.filter((e) => Math.abs(e.entrySec - entrySec) >= windowSec)
}
