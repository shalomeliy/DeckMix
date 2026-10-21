import * as ctl from '@/controls'
import { useStore } from '@/app/state/store'

/**
 * v0.5.4: automatic, non-blocking rating for the exit point a transition just
 * used — the owner's own request, right down to the wording ("worked well
 * before" for a repeat "excellent" pick, `Deck.tsx`'s `Pill`). Sits under
 * the top bar exactly where `App.tsx`'s own `notice` bar does, for the same
 * reason: a prompt the DJ has to go hunting for might as well not exist.
 * Never blocks the deck it's about — mixing continues underneath it exactly
 * as if it weren't there, and it disappears the moment any button is
 * pressed (`ctl.rateMixTransition`, which also clears the underlying state
 * so a stale prompt can't be answered twice).
 */
export function TransitionRatingPrompt() {
  const pending = useStore((s) => s.pendingMixRating)
  if (!pending) return null
  // v0.12.15: this point is already saved as Excellent — asking "how did it work" again would let one odd listen overwrite a settled rating.
  if (pending.alreadyExcellent) {
    return (
      <div className="flex shrink-0 items-center gap-2 bg-surface-2 px-4 py-1.5 text-2xs text-grid-muted">
        <span className="min-w-0 flex-1 truncate">This mix was already rated Excellent.</span>
        <button
          onClick={() => ctl.rateMixTransition('remove-excellent')}
          className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 hover:bg-surface-3"
        >
          Remove Excellent
        </button>
        <button
          onClick={() => ctl.rateMixTransition('keep')}
          className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 font-semibold text-live hover:bg-surface-3"
        >
          Keep
        </button>
      </div>
    )
  }
  return (
    <div className="flex shrink-0 items-center gap-2 bg-surface-2 px-4 py-1.5 text-2xs text-grid-muted">
      <span className="min-w-0 flex-1 truncate">
        How did that exit from “{pending.trackName}” work?
      </span>
      <button
        onClick={() => ctl.rateMixTransition('bad')}
        className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 hover:bg-surface-3"
      >
        Bad
      </button>
      <button
        onClick={() => ctl.rateMixTransition('needs-work')}
        className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 hover:bg-surface-3"
      >
        Needs work
      </button>
      <button
        onClick={() => ctl.rateMixTransition('excellent')}
        className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 font-semibold text-live hover:bg-surface-3"
      >
        Excellent
      </button>
    </div>
  )
}
