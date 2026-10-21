/**
 * Mixes the owner rated "Bad" (v0.12.14).
 *
 * A bad mix is one pair (outgoing → incoming) entered at one second of the incoming song. Mix Assist's panel lists several ways in for the
 * same pair, so what is remembered is the entry second: the same pair at another second is a different mix and stays offered. Entries are
 * matched with a window, not by equality, because the panel re-plans from the live position and its float never repeats exactly.
 */

export interface BadEntry {
  entrySec: number
  /** `Date.now()` when rated */
  at: number
}

/** Narrower than `SAME_ENTRY_WINDOW_SEC` (pair-entries): that one merges two ratings of one point, this one hides rows, and a neighbouring row must survive. */
export const SAME_BAD_WINDOW_SEC = 4

export const isBadEntry = (bad: readonly BadEntry[], entrySec: number): boolean =>
  bad.some((b) => Math.abs(b.entrySec - entrySec) < SAME_BAD_WINDOW_SEC)

/** Adds a rated-bad second; one within the window of an existing one only refreshes it. */
export function addBadEntry(existing: readonly BadEntry[], next: BadEntry): BadEntry[] {
  return [...existing.filter((b) => Math.abs(b.entrySec - next.entrySec) >= SAME_BAD_WINDOW_SEC), next]
}

/**
 * Splits a panel section into what is offered and how many rows the owner's Bad ratings took out, so the panel can say the number
 * (never skip silently) instead of just shortening.
 */
export function withoutBad<T>(
  rows: readonly T[],
  entrySecOf: (row: T) => number,
  bad: readonly BadEntry[],
  excellentSecs: readonly number[] = [],
): { shown: T[]; hidden: number } {
  if (bad.length === 0) return { shown: [...rows], hidden: 0 }
  // an Excellent point is never hidden by a Bad (owner, 21/10)
  const shown = rows.filter((r) => isExcellentEntry(excellentSecs, entrySecOf(r)) || !isBadEntry(bad, entrySecOf(r)))
  return { shown, hidden: rows.length - shown.length }
}

export const isExcellentEntry = (excellentSecs: readonly number[], entrySec: number): boolean =>
  excellentSecs.some((s) => Math.abs(s - entrySec) < SAME_BAD_WINDOW_SEC)

/** Rows the owner rated Excellent first, each group keeping its own order. */
export function excellentFirst<T>(rows: readonly T[], entrySecOf: (row: T) => number, excellentSecs: readonly number[]): T[] {
  if (excellentSecs.length === 0) return [...rows]
  const good = rows.filter((r) => isExcellentEntry(excellentSecs, entrySecOf(r)))
  return [...good, ...rows.filter((r) => !isExcellentEntry(excellentSecs, entrySecOf(r)))]
}
