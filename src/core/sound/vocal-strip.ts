/**
 * From audio to the vocal strip (v0.9.10b): the frozen classifier of vocal-model.ts run over a whole track, turned into the
 * timeline of vocal-timeline.ts (only `vocal`/`none` cells since 03/10; other
 * paths still use `unsure`). Pure — the caller decodes, picks the genre and runs this where it likes (a Worker in the app).
 *
 * What the strip is for (the owner, 03/10, after seeing it jump on every word): a DJ needs "singing here" and "no singing here", not a
 * syllable meter. A singer's breath, a pause between lines or a held ornament is still the vocal part; only a stop of MORE than two seconds is
 * "no vocals" — his rule, and the way he marks songs by hand. So the strip is two-valued now (the earlier "unsure" middle band is gone: 31% of
 * his marked songs were drawn dashed, which answered nothing), and the probabilities go through three steps, in this order:
 *  1. smooth over ±`SMOOTH_RADIUS_CELLS`;
 *  2. hysteresis: a voice starts at `VOICE_ON_AT` and only ends below `VOICE_OFF_AT`, so a value wobbling between the two cannot flicker;
 *  3. his rule: a gap of `MAX_GAP_SEC` or less inside a voice is filled; then a voice shorter than `MIN_VOICE_SEC` is dropped (a shout or a
 *     chop, which his definition of "vocals" already excludes). Dropping can only widen gaps, so no second fill is needed.
 * On clean input the rule is exact: a 2 s pause is filled, a 2.5 s one is not, a 1.5 s shout is dropped (pinned in tests).
 *
 * MEASURED, not guessed, on his 20 hand-marked songs (deckmix-vocal-marks-2026-10-04.json; scripts/train/dump-strip-probs.mjs, then
 * measure-strip-marks.mjs for these numbers and calibrate-strip-marks.py for how the settings were picked). Agreement per half second with his
 * marks: 63.9% before (reading "unsure" as voice, as the timers did; 71.6% reading it as none) -> 75.3%, and 75.2% when every song is scored by
 * settings chosen on the other 19 only. Voice sections drawn: 287 before -> 84; he has 78. The ceiling is the model, not this file: on his
 * first 13 songs it ranked his voice half seconds above his no-voice ones only 75% of the time, and retraining it on those songs alone did
 * not beat that (leave-one-song-out, 66-68%).
 */
import { cellFeatureRows, CELL_SEC } from '@/core/sound/cell-features'
import { cellProbabilities, type VocalModel } from '@/core/sound/vocal-model'
import { vocalFeatures } from '@/core/sound/vocal-presence'
import { CELL_NONE, CELL_VOCAL, VOCAL_CELL_SEC, stateOfTimeline, type VocalResult } from '@/core/sound/vocal-timeline'
import type { PcmData } from '@/core/ports/analyzer'

/** A voice starts when the smoothed probability reaches this… */
export const VOICE_ON_AT = 0.5
/** …and ends only when it falls below this. */
export const VOICE_OFF_AT = 0.25
/** Probabilities are averaged over this many cells each side first (±1 s), so one noisy half second cannot start or end a voice. */
export const SMOOTH_RADIUS_CELLS = 2
/** The owner's rule: a stop in the singing of this long or shorter is still singing. */
export const MAX_GAP_SEC = 2
/** A voice shorter than this is dropped: a shout or a chop, not the vocal part. FITTED on his marks (1-6 s tried), not his rule; 1 s and 2 s scored the same, 2 s is the one that matches his gap rule. */
export const MIN_VOICE_SEC = 2
/** Genres where the owner's rule beats the model: Trance vocals are not what the strip is for, and the model could not be shown to beat "none" there. A RULE, not a measurement. */
export const NO_STRIP_GENRES: readonly string[] = ['Trance']

if (CELL_SEC !== VOCAL_CELL_SEC) throw new Error('vocal-strip: the feature cell and the strip cell must be the same half second')

/** Fills every run of `CELL_NONE` of at most `maxCells` that has a voice on both sides. In place. */
function fillGaps(cells: Uint8Array, maxCells: number): void {
  let lastVoice = -1
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== CELL_VOCAL) continue
    if (lastVoice >= 0 && i - lastVoice - 1 > 0 && i - lastVoice - 1 <= maxCells) cells.fill(CELL_VOCAL, lastVoice + 1, i)
    lastVoice = i
  }
}

/** Per-cell probabilities → cells, through the three steps in the header. Exported for tests; no audio. */
export function cellsFromProbabilities(probs: ArrayLike<number>): Uint8Array {
  const n = probs.length
  const cells = new Uint8Array(n)
  let on = false
  const smooth = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    let c = 0
    for (let j = Math.max(0, i - SMOOTH_RADIUS_CELLS); j <= Math.min(n - 1, i + SMOOTH_RADIUS_CELLS); j++) {
      s += probs[j]
      c++
    }
    smooth[i] = s / c
  }
  for (let i = 0; i < n; i++) {
    // The end is judged one cell AHEAD. Without that, the low "off" level plus the smoothing kept every voice on for one extra half second
    // (the window still holds two voice cells just after a voice stops), so every gap reached the 2 s rule one cell short: a 2.5 s pause was
    // filled and a 1.5 s shout survived. Found by the independent review; the tests below pin both cases.
    if (on && smooth[Math.min(n - 1, i + 1)] < VOICE_OFF_AT) on = false
    else if (!on && smooth[i] >= VOICE_ON_AT) on = true
    cells[i] = on ? CELL_VOCAL : CELL_NONE
  }
  const maxGap = Math.round(MAX_GAP_SEC / VOCAL_CELL_SEC)
  const minVoice = Math.round(MIN_VOICE_SEC / VOCAL_CELL_SEC)
  fillGaps(cells, maxGap)
  for (let i = 0; i < n; ) {
    let j = i
    while (j < n && cells[j] === cells[i]) j++
    if (cells[i] === CELL_VOCAL && j - i < minVoice) cells.fill(CELL_NONE, i, j)
    i = j
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
    const { probs, genreKnown, fromOwnerMarks } = cellProbabilities(rows, genre, model)
    const timeline = { cells: cellsFromProbabilities(probs), stereo: r.features.stereo }
    // Named, so he can tell a strip learned from his own marks from the general one. A note replaces the "no vocals" text on screen
    // (vocalStateText, for the Trance rule), so when this one finds no voice it has to say that itself — or the answer disappears.
    const state = stateOfTimeline(timeline)
    const learned = `נלמד מהסימונים שלך ב-${genre}`
    const note = fromOwnerMarks ? (state === 'no-vocals' ? `אין שירה — ${learned}` : learned) : genreKnown ? undefined : "ז'אנר לא מוכר למודל — פחות בטוח"
    return { state, timeline, note }
  } catch (err) {
    return { state: 'failed', timeline: null, note: err instanceof Error ? err.message : String(err) }
  }
}
