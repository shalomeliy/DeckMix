/**
 * Where the owner scrolled the track list, remembered per view (v0.9.39).
 *
 * The table shows different lists over the same scroll box: the whole library, Mix Only's suggestions (switched on by
 * itself when a deck starts playing and off when both stop), a "More like this" list. v0.9.x kept ONE offset — the last
 * one seen while the list had rows — and put it back after the automatic switch. That number was overwritten by the
 * suggestions list on the way in: the scroll box clamps 2000px down to the few rows the suggestions have, the browser
 * fires a scroll event for the clamp, and the "last good offset" became 0. Pause, or the song ending, then restored
 * that 0 to the whole library — the list jumped to the top (Shalom, 06/10: genre filter, scroll down, load, play, pause).
 *
 * So each view keeps its own offset, and while a restore is pending, scroll events are the browser clamping or this
 * code assigning — never the owner — so they record nothing. The owner touching the list (wheel, drag, key, click)
 * ends a pending restore at once, so a restore never fights his hand.
 *
 * Pure — no DOM, no React. `app/components/Library.tsx` feeds it the scroll box's real numbers.
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

/** A scroll event. `hasRows` false = a transient empty list, whose 0 says nothing about where the owner was. */
export function recordScroll(m: ScrollMemory, top: number, hasRows: boolean): void {
  if (m.pending != null || !hasRows) return
  m.byView.set(m.view, top)
}

/**
 * The table switched lists. Returns the offset to put back — where the owner left this view, or the top on a first
 * visit — or null when the view did not change.
 */
export function switchView(m: ScrollMemory, view: string): number | null {
  if (view === m.view) return null
  m.view = view
  m.pending = m.byView.get(view) ?? 0
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

/** The owner touched the list, or the restore timed out (the list got shorter while he was away): stop restoring. */
export function endRestore(m: ScrollMemory, actual?: number): void {
  if (m.pending == null) return
  m.pending = null
  if (actual != null) m.byView.set(m.view, actual)
}
