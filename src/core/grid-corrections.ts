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
  /**
   * v0.9.45b: the tempo itself was set by hand — ÷2, ×2 or Tap. Only then does the saved count beat the track's own label (file tag or
   * detection) when the two are an octave apart: a grid saved for its phase alone — a nudge, "set downbeat", a check, a tagging answer —
   * keeps whatever octave the detection had that day. Shalom's 150 hip-hop track came back as 75 forever from exactly such a record
   * (06/10). Optional, so records from before it read as "not by hand" with no schema change.
   */
  tempoByHand?: boolean
}

export function ownerCorrection(grid: BeatGrid, savedAt: number, tempoByHand = false): GridCorrection {
  return {
    schema: GRID_CORRECTION_SCHEMA,
    grid: { bpm: grid.bpm, offsetSec: grid.offsetSec },
    source: 'owner',
    savedAt,
    ...(tempoByHand ? { tempoByHand: true } : {}),
  }
}

/**
 * The grid to put on the deck from a stored record, or `null` when there is
 * nothing usable. A record from a newer schema, or one whose numbers could
 * not draw a grid (a 0 or NaN bpm), is refused rather than half-read — the
 * caller says so on screen and falls back to the detected grid.
 */
export function resolveGridCorrection(stored: unknown): { grid: BeatGrid; tempoByHand: boolean } | { refused: string } | null {
  if (stored == null) return null
  const r = stored as Partial<GridCorrection>
  if (r.schema !== GRID_CORRECTION_SCHEMA) return { refused: `unknown format (${String(r.schema)})` }
  const g = r.grid
  if (!g || !Number.isFinite(g.bpm) || g.bpm <= 0 || !Number.isFinite(g.offsetSec) || g.offsetSec < 0) {
    return { refused: 'damaged record' }
  }
  return { grid: { bpm: g.bpm, offsetSec: g.offsetSec }, tempoByHand: r.tempoByHand === true }
}

/**
 * A saved grid against the track's label (v0.9.45): the BPM the owner typed, else — when the saved tempo was not set by hand
 * (`tempoByHand`) — the file tag or the detection. The two can count one song at different octaves: Shalom's hip-hop track plays at 150
 * and the row said 150, but a grid saved at 75 always won on the deck (06/10). The label is the count of the beat; the saved grid is the
 * phase. So:
 * - within 2%: the same tempo (the load's own 2% rule) — the grid's finer number stays;
 * - double or half: the grid is recounted to the label, its bar line kept (`doubleGrid`/`halveGrid`);
 * - anything else: the saved grid stays — the caller says so on screen when the label is the owner's own.
 */
export function reconcileSavedGrid(grid: BeatGrid, labelBpm: number): { grid: BeatGrid; outcome: 'same' | 'recounted' | 'differs' } {
  const ratio = labelBpm / grid.bpm
  if (Math.abs(ratio - 1) <= 0.02) return { grid, outcome: 'same' }
  if (Math.abs(ratio / 2 - 1) <= 0.02) return { grid: doubleGrid(grid), outcome: 'recounted' }
  if (Math.abs(ratio * 2 - 1) <= 0.02) return { grid: halveGrid(grid), outcome: 'recounted' }
  return { grid, outcome: 'differs' }
}
