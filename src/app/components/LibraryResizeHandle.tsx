import { useRef } from 'react'
import * as ctl from '@/controls'
import { useStore } from '@/app/state/store'

/**
 * How far the pointer has to travel before the list switches size. Small
 * enough that a short flick does it, big enough that a click on the strip, or
 * a hand that shakes on the way to the library, does not.
 */
const SWITCH_PX = 24

/**
 * The grab strip on the track list's top edge (v0.9.34, Shalom 06/10: "make
 * the songs part bigger, upward only; the pads go away, and come back when I
 * make it smaller").
 *
 * Two sizes, not a free drag. The list can only grow by taking height the decks
 * give up, and the decks give it up in one piece (pads + platter, see
 * `libraryExpanded` in the store); a free drag would promise heights in
 * between that nothing on the screen can actually make room for.
 */
export function LibraryResizeHandle() {
  const expanded = useStore((s) => s.libraryExpanded)
  const drag = useRef<{ startY: number; pointerId: number } | null>(null)

  return (
    <button
      type="button"
      aria-label={expanded ? 'Make the track list smaller (pads come back)' : 'Make the track list bigger (hides the pads)'}
      aria-expanded={expanded}
      title={
        expanded
          ? 'Drag down (or double-click) to make the track list smaller. The pads come back.'
          : 'Drag up (or double-click) to make the track list bigger. The pads hide while it is big.'
      }
      className="group absolute inset-x-3 -top-3 z-10 flex h-3 cursor-row-resize touch-none items-center justify-center outline-none"
      // A press must not leave the strip focused: it owns the arrow keys, and
      // the next arrow meant for the track list would resize it instead.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        drag.current = { startY: e.clientY, pointerId: e.pointerId }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.pointerId !== e.pointerId) return
        const up = d.startY - e.clientY
        const isExpanded = useStore.getState().libraryExpanded
        // Measured from where the size last changed, so dragging up and then
        // back down in one stroke switches back, like a drawer.
        if (!isExpanded && up > SWITCH_PX) {
          ctl.setLibraryExpanded(true)
          d.startY = e.clientY
        } else if (isExpanded && up < -SWITCH_PX) {
          ctl.setLibraryExpanded(false)
          d.startY = e.clientY
        }
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onDoubleClick={() => ctl.toggleLibraryExpanded()}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') ctl.setLibraryExpanded(true)
        else if (e.key === 'ArrowDown') ctl.setLibraryExpanded(false)
        else if (e.key === 'Enter' || e.key === ' ') ctl.toggleLibraryExpanded()
        else return
        // The window-level keys in App.tsx move the library selection on the
        // arrows; one key press doing both would be two things at once.
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <span className="h-1 w-12 rounded-full bg-hairline transition-colors group-hover:bg-grid-muted group-focus-visible:bg-[var(--color-accent)]" />
      {/* The size is saved, so after a reload the pads are simply gone; this
          line is what says why, and how to get them back. */}
      {expanded && (
        <span className="ml-2 text-[10px] leading-none text-grid-muted">Pads hidden · drag down to bring them back</span>
      )}
    </button>
  )
}
