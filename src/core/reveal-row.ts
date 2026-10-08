/** Fired by `moveSelection` after the highlight moved by hand; the track table answers it by scrolling the selected row into view. */
export const REVEAL_SELECTION_EVENT = 'deckmix-reveal-selection'

/**
 * Where to scroll so that row `index` is fully visible (v0.9.62), or `null` when it already is.
 *
 * 08/10: the owner turned the controller's browse wheel and the highlight walked down out of the window, so he was "on a song he cannot see".
 * Moves the minimum: a row below the window comes to the bottom edge, one above comes just under the sticky header. `headerH` is the height of
 * that header, which covers the top of the scrolling box.
 */
export function scrollTopToReveal(index: number, rowH: number, scrollTop: number, viewH: number, headerH: number): number | null {
  const rowTop = headerH + index * rowH // the row's top in the box's own scroll space (the header is the first thing in it)
  const rowBottom = rowTop + rowH
  const visibleTop = scrollTop + headerH // under the sticky header
  const visibleBottom = scrollTop + viewH
  if (rowTop < visibleTop) return Math.max(0, rowTop - headerH)
  if (rowBottom > visibleBottom) return rowBottom - viewH
  return null
}
