/**
 * A beat grid the owner fixed by hand (v0.8.23), and what a stored one has to
 * look like before it is trusted again. Kept apart from the analysis cache on
 * purpose: that cache is thrown away whenever `ANALYZER_VERSION` moves, and a
 * correction the owner made is not a guess the next analyzer may redo — until
 * v0.8.23 every nudge and "Set downbeat here" lived only in the deck's state
 * and was gone at the next load.
 *
 * `source` is there for v0.9.0, whose "where is the 1" tagging lands in the
 * same store: an owner's correction and a detector's answer must never be
 * confused for each other.
 */
import { doubleGrid, halveGrid } from '@/core/beatgrid'
import type { BeatGrid } from '@/core/types'

export const GRID_CORRECTION_SCHEMA = 1

export interface GridCorrection {
  schema: number
  grid: BeatGrid
  source: 'owner' | 'detector'
  savedAt: number
}

export function ownerCorrection(grid: BeatGrid, savedAt: number): GridCorrection {
  return { schema: GRID_CORRECTION_SCHEMA, grid: { bpm: grid.bpm, offsetSec: grid.offsetSec }, source: 'owner', savedAt }
}

/**
 * The grid to put on the deck from a stored record, or `null` when there is
 * nothing usable. A record from a newer schema, or one whose numbers could
 * not draw a grid (a 0 or NaN bpm), is refused rather than half-read — the
 * caller says so on screen and falls back to the detected grid.
 */
export function resolveGridCorrection(stored: unknown): { grid: BeatGrid } | { refused: string } | null {
  if (stored == null) return null
  const r = stored as Partial<GridCorrection>
  if (r.schema !== GRID_CORRECTION_SCHEMA) return { refused: `unknown format (${String(r.schema)})` }
  const g = r.grid
  if (!g || !Number.isFinite(g.bpm) || g.bpm <= 0 || !Number.isFinite(g.offsetSec) || g.offsetSec < 0) {
    return { refused: 'damaged record' }
  }
  return { grid: { bpm: g.bpm, offsetSec: g.offsetSec } }
}

/**
 * A saved grid against the BPM the owner typed (v0.9.45). Two answers the owner gave at different times can count the same song at
 * different octaves: Shalom fixed or confirmed a hip-hop grid at 75, later typed Beatport's 150, and the deck kept saying 75 while the
 * row said 150 (06/10) — the Beatport panel had told him the new BPM "applies the next time you load this track", and it never did,
 * because the saved grid always won. The typed number is his count of the beat; the saved grid is his phase. So:
 * - within 2%: the same tempo (the load's own 2% rule) — the grid's finer number stays, nothing to say;
 * - double or half: the grid is recounted to his number, its bar line kept (`doubleGrid`/`halveGrid`);
 * - anything else: the grid he checked stays, and the caller says on screen that the two disagree — never one quietly dropped.
 */
export function reconcileOwnerBpm(grid: BeatGrid, ownerBpm: number): { grid: BeatGrid; outcome: 'same' | 'recounted' | 'differs' } {
  const ratio = ownerBpm / grid.bpm
  if (Math.abs(ratio - 1) <= 0.02) return { grid, outcome: 'same' }
  if (Math.abs(ratio / 2 - 1) <= 0.02) return { grid: doubleGrid(grid), outcome: 'recounted' }
  if (Math.abs(ratio * 2 - 1) <= 0.02) return { grid: halveGrid(grid), outcome: 'recounted' }
  return { grid, outcome: 'differs' }
}
