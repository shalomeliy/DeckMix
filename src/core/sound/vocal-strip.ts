/**
 * From audio to the vocal strip (v0.9.10b): the frozen classifier of vocal-model.ts run over a whole track, turned into the three-valued
 * timeline of vocal-timeline.ts. Pure — the caller decodes, picks the genre and runs this where it likes (a Worker in the app).
 *
 * The owner's choice (03/10, "a careful guard"): the strip would rather warn about a vocal that is not there than hide one that is, because it
 * exists to stop a lead voice clashing in a mix. So `VOCAL_AT` is low, `NONE_AT` is lower still, and everything between is "unsure" — drawn
 * dashed, never as "no vocals". The sealed measurement agreed with the direction: its errors were nearly all false alarms (said voice, owner said none).
 *
 * `VOCAL_AT`/`NONE_AT` are NOT measured thresholds: the model was scored at 0.5 and nothing here has been tuned on a held-out set.
 * They are pinned in tests so a change is a decision, and listed as known debt in HANDOFF.md until a calibration run exists.
 */
import { cellFeatureRows, CELL_SEC } from '@/core/sound/cell-features'
import { cellProbabilities, type VocalModel } from '@/core/sound/vocal-model'
import { vocalFeatures } from '@/core/sound/vocal-presence'
import { CELL_NONE, CELL_UNSURE, CELL_VOCAL, VOCAL_CELL_SEC, stateOfTimeline, type VocalResult } from '@/core/sound/vocal-timeline'
import type { PcmData } from '@/core/ports/analyzer'

export const VOCAL_AT = 0.4
export const NONE_AT = 0.15
/** Probabilities are averaged over this many cells each side before the thresholds, so one noisy half second cannot flip the strip. */
export const SMOOTH_RADIUS_CELLS = 1
/** Genres where the owner's rule beats the model: Trance vocals are not what the strip is for, and the model could not be shown to beat "none" there. A RULE, not a measurement. */
export const NO_STRIP_GENRES: readonly string[] = ['Trance']

if (CELL_SEC !== VOCAL_CELL_SEC) throw new Error('vocal-strip: the feature cell and the strip cell must be the same half second')

/** Per-cell probabilities → cells. Exported for tests; no audio. */
export function cellsFromProbabilities(probs: ArrayLike<number>): Uint8Array {
  const n = probs.length
  const cells = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    let c = 0
    for (let j = Math.max(0, i - SMOOTH_RADIUS_CELLS); j <= Math.min(n - 1, i + SMOOTH_RADIUS_CELLS); j++) {
      s += probs[j]
      c++
    }
    const p = s / c
    cells[i] = p >= VOCAL_AT ? CELL_VOCAL : p <= NONE_AT ? CELL_NONE : CELL_UNSURE
  }
  return cells
}

/** The whole path. Never throws: every outcome is a named state (the project's "never skip silently"). */
export function detectVocalStrip(pcm: PcmData, genre: string, model: VocalModel): VocalResult {
  try {
    if (NO_STRIP_GENRES.includes(genre)) {
      // Not analysed at all: say so under its own name instead of drawing an empty lane that reads like a measurement.
      return { state: 'no-vocals', timeline: null, note: `${genre}: כלל ז'אנר, לא נמדד` }
    }
    const r = vocalFeatures(pcm)
    if ('result' in r) return r.result
    const durationSec = pcm.channels[0].length / pcm.sampleRate
    const rows = cellFeatureRows(r.features, durationSec)
    const { probs, genreKnown } = cellProbabilities(rows, genre, model)
    const timeline = { cells: cellsFromProbabilities(probs), stereo: r.features.stereo }
    const note = genreKnown ? undefined : "ז'אנר לא מוכר למודל — פחות בטוח"
    return { state: stateOfTimeline(timeline), timeline, note }
  } catch (err) {
    return { state: 'failed', timeline: null, note: err instanceof Error ? err.message : String(err) }
  }
}
