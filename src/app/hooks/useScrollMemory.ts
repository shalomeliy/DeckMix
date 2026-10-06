import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  createScrollMemory,
  endRestore,
  recordScroll,
  restoreLanded,
  switchView,
} from '@/core/scroll-memory'

/** How long a restore keeps trying before it gives up (the list got shorter while the owner was away). */
const RESTORE_TIMEOUT_MS = 800

/**
 * The DOM half of `core/scroll-memory.ts` (v0.9.39): keeps the owner's scroll offset per list the same box shows.
 *
 * `deps` is what the caller re-renders on (row count, the rendered window's spacers). The restore is attempted on
 * every one of those commits, not once, because a virtual list's scroll height catches up a render AFTER the rows
 * change — the first assignment is clamped by the old list's height.
 */
export function useScrollMemory(
  containerRef: RefObject<HTMLDivElement | null>,
  view: string,
  hasRows: boolean,
  deps: unknown[],
) {
  const mem = useRef(createScrollMemory(view))
  const hasRowsRef = useRef(hasRows)
  hasRowsRef.current = hasRows
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const m = mem.current
    const onScroll = () => recordScroll(m, el.scrollTop, hasRowsRef.current)
    // The owner's own hand ends a pending restore, so it never pulls the list back from under him.
    const onHand = () => endRestore(m, el.scrollTop)
    const hand = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const
    el.addEventListener('scroll', onScroll, { passive: true })
    for (const t of hand) el.addEventListener(t, onHand, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      for (const t of hand) el.removeEventListener(t, onHand)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-attached when the box itself is replaced, which `hasRows` tracks (the empty states render no box)
  }, [containerRef, hasRows])

  useLayoutEffect(() => {
    const m = mem.current
    if (switchView(m, view) != null) {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(
        () => endRestore(m, containerRef.current?.scrollTop),
        RESTORE_TIMEOUT_MS,
      )
    }
    const el = containerRef.current
    if (m.pending == null || !el) return
    el.scrollTop = m.pending
    restoreLanded(m, el.scrollTop)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's own render signal, spread so a new list length or window re-tries the restore
  }, [view, containerRef, ...deps])

  useEffect(() => () => window.clearTimeout(timer.current), [])
}
