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
export function withoutBad<T>(rows: readonly T[], entrySecOf: (row: T) => number, bad: readonly BadEntry[]): { shown: T[]; hidden: number } {
  if (bad.length === 0) return { shown: [...rows], hidden: 0 }
  const shown = rows.filter((r) => !isBadEntry(bad, entrySecOf(r)))
  return { shown, hidden: rows.length - shown.length }
}
