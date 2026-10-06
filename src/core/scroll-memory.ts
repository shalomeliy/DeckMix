/**
 * Where the owner scrolled the track list, remembered per view (v0.9.39).
 *
 * The table shows different lists over the same scroll box: the whole library, Mix Only's suggestions (switched on by
 * itself when a deck starts playing and off when both stop), Duplicates only, a "More like this" list. v0.12.10 kept ONE
 * offset — the last one seen while the list had rows — and put it back after the automatic switch. That number was
 * overwritten on the way in: with a genre filter on, the suggestions are a few rows, the scroll box clamps 2000px down
 * to them, the browser fires a scroll event for the clamp, and the "last good offset" became the clamp. Pause, or the
 * song ending, then restored that to the whole library — the list jumped to the top (Shalom, 06/10: genre filter,
 * scroll down, load, play, pause).
 *
 * So each view keeps its own offset, and:
 * - while a restore is pending, scroll events are the browser clamping or this code assigning — never the owner — so
 *   they record nothing;
 * - the owner's hand (wheel, click, key) ends a pending restore at once and his position is what is kept;
 * - a restore that times out (the list got shorter while he was away) records nothing: the clamp is not where he was;
 * - the suggestions always open at their top (v0.9.42, Shalom 06/10: "you don't bring me to the top of the list and I
 *   always have to scroll there") — they are ranked best first, and the offset he had in the library means nothing in
 *   them. Pause or the song ending still brings the library back to where he left it;
 * - any other view seen for the first time is not scrolled anywhere — the box keeps its offset, as the browser leaves it.
 *
 * What is deliberately NOT a separate view: a search, a sort, a crate, a column filter. Those make a new list out of the
 * same view, and the browser's clamp is what the owner sees — the same as before v0.9.39.
 *
 * Pure — no DOM, no React. `app/hooks/useScrollMemory.ts` feeds it the scroll box's real numbers.
 */
export interface ScrollMemory {
  view: string
  byView: Map<string, number>
  /** The offset still to be put back for `view`; null once it landed, the owner took over, or it expired. */
  pending: number | null
}

export function createScrollMemory(view: string): ScrollMemory {
  return { view, byView: new Map(), pending: null }
}

/**
 * The key of the list the table is drawing. Every view toggle that swaps the list for a different one belongs here —
 * leaving one out puts two lists under one offset, which is the bug this module exists for. The suggestions are a
 * different list for every pair of deck tracks, so they are keyed by them: an offset in one play's suggestions means
 * nothing in the next one's.
 */
export function listViewKey(v: {
  similarTo: string | null
  mixOnly: boolean
  dupOnly: boolean
  deckIds: readonly (string | null)[]
}): string {
  if (v.similarTo) return `similar:${v.similarTo}`
  const base = v.dupOnly ? 'dups' : 'all'
  return v.mixOnly ? `${MIX_PREFIX}${base}:${v.deckIds.map((id) => id ?? '-').join('|')}` : base
}

const MIX_PREFIX = 'mix:'

/** The suggestions open at the top every time (v0.9.42): the best matches are ranked first. */
export function opensAtTop(view: string): boolean {
  return view.startsWith(MIX_PREFIX)
}

/** A scroll event. `hasRows` false = a transient empty list, whose 0 says nothing about where the owner was. */
export function recordScroll(m: ScrollMemory, top: number, hasRows: boolean): void {
  if (m.pending != null || !hasRows) return
  m.byView.set(m.view, top)
}

/**
 * The table switched lists. Returns the offset to put back — the top for the suggestions, where the owner left any other
 * view — or null when there is nothing to restore (the same view, or a view never seen before, which keeps the box's
 * offset as it is).
 */
export function switchView(m: ScrollMemory, view: string): number | null {
  if (view === m.view) return null
  m.view = view
  m.pending = opensAtTop(view) ? 0 : (m.byView.get(view) ?? null)
  return m.pending
}

/**
 * The scroll box was replaced (an empty state unmounted it, and it came back at 0) while the view stayed the same.
 * Returns the offset to put back, or null when this view has none.
 */
export function boxReplaced(m: ScrollMemory): number | null {
  m.pending = m.byView.get(m.view) ?? null
  return m.pending
}

/**
 * After assigning `pending` to the scroll box: `actual` is what the box kept. Less than asked means the rendered rows
 * are not tall enough yet (the virtual window catches up a render later), so the restore stays pending for the next
 * commit; equal means it landed.
 */
export function restoreLanded(m: ScrollMemory, actual: number): void {
  if (m.pending != null && Math.abs(actual - m.pending) < 1) m.pending = null
}

/** The owner touched the list: stop restoring, and where he is now is this view's offset. */
export function ownerTookOver(m: ScrollMemory, actual: number): void {
  if (m.pending == null) return
  m.pending = null
  m.byView.set(m.view, actual)
}

/**
 * The restore ran out of time — the list is shorter than it was and the old offset no longer exists. Stop, and keep the
 * remembered offset: writing the clamp back would land every later visit at the bottom.
 */
export function restoreExpired(m: ScrollMemory): void {
  m.pending = null
}
