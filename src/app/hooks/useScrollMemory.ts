import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  boxReplaced,
  createScrollMemory,
  ownerTookOver,
  recordScroll,
  restoreExpired,
  restoreLanded,
  switchView,
} from '@/core/scroll-memory'

/** How long a restore keeps trying before it gives up (the list got shorter while the owner was away). */
const RESTORE_TIMEOUT_MS = 800

/**
 * The DOM half of `core/scroll-memory.ts` (v0.9.39): keeps the owner's scroll offset per list the same box shows.
 *
 * `renderKey` changes whenever the rows or the rendered window change. The restore is attempted on every one of those
 * commits, not once, because a virtual list's scroll height catches up a render AFTER the rows change — the first
 * assignment is clamped by the old list's height.
 */
export function useScrollMemory(
  containerRef: RefObject<HTMLDivElement | null>,
  view: string,
  hasRows: boolean,
  renderKey: string,
) {
  const [mem] = useState(() => createScrollMemory(view))
  const hasRowsRef = useRef(hasRows)
  hasRowsRef.current = hasRows
  /** The last box listened to — kept while an empty state shows, so the box that comes back is seen as a replacement. */
  const box = useRef<HTMLDivElement | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const unbind = useRef<(() => void) | null>(null)

  // Bound to whichever box is mounted, re-bound when an empty state replaced it.
  const listen = (el: HTMLDivElement) => {
    const onScroll = () => recordScroll(mem, el.scrollTop, hasRowsRef.current)
    // The owner's own hand ends a pending restore, so it never pulls the list back from under him.
    const onHand = () => ownerTookOver(mem, el.scrollTop)
    const hand = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const
    el.addEventListener('scroll', onScroll, { passive: true })
    for (const t of hand) el.addEventListener(t, onHand, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      for (const t of hand) el.removeEventListener(t, onHand)
    }
  }

  useLayoutEffect(() => {
    const el = containerRef.current
    const startTimer = () => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => restoreExpired(mem), RESTORE_TIMEOUT_MS)
    }
    if (switchView(mem, view) != null) startTimer()
    // The empty states render no box, so a list that is empty for one render comes back as a NEW box at 0 — with the
    // view unchanged there is no switch to restore it, and that is a jump to the top too.
    if (el && box.current && el !== box.current && boxReplaced(mem) != null) startTimer()
    if (el && el !== box.current) {
      unbind.current?.()
      unbind.current = listen(el)
      box.current = el
    }
    if (mem.pending == null || !el) return
    el.scrollTop = mem.pending
    restoreLanded(mem, el.scrollTop)
  }, [view, containerRef, renderKey, mem])

  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      unbind.current?.()
    },
    [],
  )
}
