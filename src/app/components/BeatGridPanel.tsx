import * as ctl from '@/controls'
import { BEATGRID_NUDGE_SEC } from '@/core/constants'
import type { BeatGrid, DeckId } from '@/core/types'
import { Button, HintIcon } from '@/app/components/controls'

interface Props {
  deckId: DeckId
  beatGrid: BeatGrid | null
  onClose: () => void
}

/**
 * Manual beat-grid correction (v0.3.0), opened from the BPM readout. Nudge
 * and half/double need an existing grid; tap-tempo and "set downbeat here"
 * work even without one — either is how a track with no detectable
 * periodicity gets its first grid.
 */
export function BeatGridPanel({ deckId, beatGrid, onClose }: Props) {
  return (
    <div
      className="absolute right-0 top-full z-30 mt-1 w-60 rounded-[var(--radius-md)] border border-hairline bg-surface-2 p-2.5 text-left shadow-[var(--shadow-pop)]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="label">Beat Grid</span>
        <button
          type="button"
          aria-label="Close"
          title="Close — marks this grid as checked"
          onClick={onClose}
          className="text-2xs text-grid-dim transition-colors hover:text-grid-text"
        >
          ✕
        </button>
      </div>

      <div className="tnum mb-2 text-2xs text-grid-muted">
        {beatGrid
          ? `${beatGrid.bpm.toFixed(1)} bpm · phase ${beatGrid.offsetSec.toFixed(3)}s`
          : 'no grid yet — tap or set a downbeat'}
      </div>

      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="w-14 text-2xs text-grid-dim">Nudge</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => ctl.nudgeBeatGrid(deckId, -BEATGRID_NUDGE_SEC)}
          disabled={!beatGrid}
        >
          −
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => ctl.nudgeBeatGrid(deckId, BEATGRID_NUDGE_SEC)}
          disabled={!beatGrid}
        >
          +
        </Button>
        <HintIcon id="beatgrid.nudge" />
      </div>

      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="w-14 text-2xs text-grid-dim">BPM</span>
        <Button variant="ghost" size="sm" onClick={() => ctl.halveBeatGrid(deckId)} disabled={!beatGrid}>
          ÷2
        </Button>
        <Button variant="ghost" size="sm" onClick={() => ctl.doubleBeatGrid(deckId)} disabled={!beatGrid}>
          ×2
        </Button>
        <HintIcon id="beatgrid.halveDouble" />
      </div>

      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={() => ctl.tapTempo(deckId)}>
          Tap
        </Button>
        <HintIcon id="beatgrid.tap" />
        <Button variant="ghost" size="sm" onClick={() => ctl.setDownbeatHere(deckId)}>
          Set downbeat here
        </Button>
        <HintIcon id="beatgrid.setDownbeat" />
      </div>
    </div>
  )
}
