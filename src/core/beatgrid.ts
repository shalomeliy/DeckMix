import type { BeatGrid } from '@/core/types'

/**
 * Beat-grid detection, phase, and quantize math — kept out of `platform/` so it
 * can be tested without an `AudioContext`, the same move `core/scratch.ts` made
 * for platter math in v0.2.2. `platform/analyzer-js/analyze.ts` still owns turning
 * an `AudioBuffer` into an onset envelope (that part touches the DOM API and has
 * to stay platform-side); everything from the envelope onward is pure and lives
 * here.
 *
 * What this can and cannot find, stated plainly rather than left to be assumed:
 * an onset envelope can locate *beat* phase (where in each `60/bpm`-second cycle
 * the energy peaks) but not *bar* phase — telling beat 1 of a bar from beats 2-4
 * needs kick/snare timbre analysis this does not do. So `estimateBeatGrid` finds
 * the nearest beat, not the nearest downbeat-of-a-bar; `setDownbeatAt` is the
 * manual tool for a user who cares which beat is bar-1. A detected grid's
 * `offsetSec` therefore sits inside the first beat; a hand-edited one sits
 * anywhere inside the first bar, and that difference is the whole edit.
 */

/**
 * `x` folded into `[0, period)`. `%` alone leaves negative results negative.
 * Only adds `period` back when the plain `%` came out negative — adding it
 * unconditionally (`((x % period) + period) % period`) puts an already-in-range
 * value through a second lossy subtraction for nothing, which is what turned
 * `0.2` into `0.19999999999999996` here before this was narrowed to the one
 * case that actually needs the correction.
 */
function foldInto(x: number, period: number): number {
  const r = x % period
  return r < 0 ? r + period : r
}

/** Fractional part of `x`, always in `[0, 1)` — `%` alone leaves it signed. */
function frac01(x: number): number {
  return x - Math.floor(x)
}

/** How far the largest value stands out from the average of all of them. */
function peakToMeanRatio(values: number[], peakIndex: number): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  if (mean <= 1e-9) return 0
  return values[peakIndex] / mean
}

/**
 * Below this ratio, the strongest candidate is not a real periodicity — a flat
 * onset envelope (silence, a spoken-word track, a clip too short to repeat a
 * beat) scores every candidate about the same, and picking the top one anyway
 * would be exactly the silent-wrong-answer this project's "never skip silently"
 * rule forbids. Chosen, not measured: revisit once real tracks are checked
 * against it (see HANDOFF.md — this whole module's constants are provisional
 * until verified against the user's library).
 */
const CONFIDENCE_RATIO = 1.15

/** Onset energy folded modulo a (fractional) beat period into ~1-frame bins. */
function foldOnsets(onsets: Float32Array, periodFrames: number): { bins: number[]; binFrames: number } {
  const nBins = Math.max(1, Math.round(periodFrames))
  const binFrames = periodFrames / nBins
  const bins = new Array<number>(nBins).fill(0)
  for (let i = 0; i < onsets.length; i++) {
    if (onsets[i] === 0) continue
    const phase = i - Math.floor(i / periodFrames) * periodFrames
    bins[Math.min(nBins - 1, Math.floor(phase / binFrames))] += onsets[i]
  }
  return { bins, binFrames }
}

/**
 * The autocorrelation above works in whole-frame lags, so its BPM is only as
 * fine as one frame of the beat period (~0.8 BPM at 100 BPM, ~2.5 at 174). A
 * grid drawn from that drifts: 0.25 BPM off at 100 BPM is half a beat out
 * after 200 beats, i.e. the middle of a song (Shalom's report, 20/09). This
 * re-scores fractional tempos around the coarse pick by how sharply the onsets
 * pile into one phase bin — the right tempo stacks every beat in the same bin
 * across the whole track, a wrong one smears them.
 */
function refineBpm(
  onsets: Float32Array,
  framesPerSec: number,
  coarseBpm: number,
  relWindow?: number,
): number {
  const window = relWindow != null ? coarseBpm * relWindow : (coarseBpm * coarseBpm) / (60 * framesPerSec)
  const tried: { c: number; score: number }[] = []
  let bestScore = -Infinity
  for (let c = coarseBpm - window; c <= coarseBpm + window; c += 0.01) {
    const { bins } = foldOnsets(onsets, (60 / c) * framesPerSec)
    let score = 0
    for (const v of bins) score += v * v
    tried.push({ c, score })
    if (score > bestScore) bestScore = score
  }
  // A clean or short envelope scores a whole plateau of tempos equally well;
  // taking the first of them lands on its edge and shifts the phase estimate
  // by a frame. The middle of the plateau is the tempo they bracket.
  const top = tried.filter((t) => t.score >= bestScore * 0.999)
  const centre = top.reduce((a, t) => a + t.c, 0) / top.length
  return Math.round(centre * 100) / 100
}

export interface BeatGridEstimate {
  grid: BeatGrid
  confident: boolean
}

/**
 * Estimate a beat grid from an onset envelope.
 *
 * `onsets` is a positive-only difference envelope (see `analyze.ts`'s
 * `buildOnsetEnvelope`), sampled at `framesPerSec`. BPM comes from the same
 * lag-autocorrelation scoring `detectBpm` used before this module existed — it
 * was already pure, only ever touching `onsets`, so it moved here unchanged.
 * Phase is new: onset energy is folded modulo the winning beat period into
 * `beatFrames` bins across the whole track, and the strongest bin is beat 0.
 *
 * Returns `null` only when there is not enough envelope to say anything at all
 * (mirrors `detectBpm`'s old `env.length < 64` guard). A flat/unconvincing
 * envelope still returns a grid — the best guess autocorrelation could make —
 * with `confident: false`, so the caller has something to show and quantize
 * against rather than nothing, while still being honest that it's a guess.
 */
export function estimateBeatGrid(
  onsets: Float32Array,
  framesPerSec: number,
  opts?: { minBpm?: number; maxBpm?: number; hintBpm?: number | null },
): BeatGridEstimate | null {
  if (onsets.length < 64) return null
  // A file tag names the tempo; the tag is usually a rounded label of it. Skip
  // the blind search (which can lock on a wrong multiple — 163 for a track
  // tagged 100) and find the exact tempo near the tag, then the phase at it.
  if (opts?.hintBpm != null && opts.hintBpm > 0) {
    const bpm = refineBpm(onsets, framesPerSec, opts.hintBpm, 0.019)
    const { bins, binFrames } = foldOnsets(onsets, (60 / bpm) * framesPerSec)
    let bestBin = 0
    for (let b = 1; b < bins.length; b++) if (bins[b] > bins[bestBin]) bestBin = b
    return {
      grid: { bpm, offsetSec: (bestBin * binFrames) / framesPerSec },
      confident: peakToMeanRatio(bins, bestBin) >= CONFIDENCE_RATIO,
    }
  }
  const min = opts?.minBpm ?? 80
  const max = opts?.maxBpm ?? 180

  const candidates: number[] = []
  const scores: number[] = []
  let bestIdx = 0
  let bestScore = -Infinity
  for (let bpm = min; bpm <= max; bpm += 0.5) {
    const lag = Math.round((60 / bpm) * framesPerSec)
    let score = 0
    for (let i = lag; i < onsets.length; i++) score += onsets[i] * onsets[i - lag]
    score /= onsets.length - lag
    candidates.push(bpm)
    scores.push(score)
    if (score > bestScore) {
      bestScore = score
      bestIdx = candidates.length - 1
    }
  }
  const bpmConfident = peakToMeanRatio(scores, bestIdx) >= CONFIDENCE_RATIO
  const bpm = refineBpm(onsets, framesPerSec, candidates[bestIdx])

  const periodFrames = (60 / bpm) * framesPerSec
  const { bins, binFrames } = foldOnsets(onsets, periodFrames)
  let bestBin = 0
  for (let b = 1; b < bins.length; b++) if (bins[b] > bins[bestBin]) bestBin = b
  const phaseConfident = peakToMeanRatio(bins, bestBin) >= CONFIDENCE_RATIO

  const offsetSec = (bestBin * binFrames) / framesPerSec
  return {
    grid: { bpm, offsetSec },
    confident: bpmConfident && phaseConfident,
  }
}

/** Nearest beat to `sec` on `grid` — what quantize snaps to. */
export function quantizeToGrid(sec: number, grid: BeatGrid): number {
  const beatSec = 60 / grid.bpm
  const beatIndex = Math.round((sec - grid.offsetSec) / beatSec)
  return grid.offsetSec + beatIndex * beatSec
}

/**
 * Signed correction, in the deck's own seconds, to bring `deckPositionSec` onto
 * `masterGrid`'s beat phase — the smallest move either forward or back, never
 * more than half a beat. Phase is compared as a *fraction* of each deck's own
 * beat cycle rather than as raw elapsed time, which is what makes this robust
 * to the two decks having slightly different detected BPMs even after SYNC's
 * tempo fader has matched their playback rates: 0.1 BPM of detection error is
 * exactly the kind of gap this function is meant to keep closing, tick after
 * tick, rather than something it can assume away.
 */
export function phaseDeltaSec(
  deckPositionSec: number,
  deckGrid: BeatGrid,
  masterPositionSec: number,
  masterGrid: BeatGrid,
): number {
  const deckBeatSec = 60 / deckGrid.bpm
  const masterBeatSec = 60 / masterGrid.bpm
  const deckPhase = frac01((deckPositionSec - deckGrid.offsetSec) / deckBeatSec)
  const masterPhase = frac01((masterPositionSec - masterGrid.offsetSec) / masterBeatSec)
  let diff = masterPhase - deckPhase
  diff -= Math.round(diff)
  return diff * deckBeatSec
}

/**
 * Beats per bar — the yellow line the waveform draws (`Waveform.tsx`) sits on
 * every `BEATS_PER_BAR`-th beat counted from `offsetSec`. One constant so the
 * line the owner sees and the line an automatic mix lands on can't disagree.
 */
export const BEATS_PER_BAR = 4

/**
 * `phaseDeltaSec`, but over a whole bar instead of a single beat: the
 * smallest signed move (never more than half a bar) that puts
 * `deckPositionSec` at the same place *within its bar* as the master is in
 * its own. Beat phase alone lets the two yellow lines land one to three
 * beats apart while every white line still matches — which is exactly what
 * the owner heard on 23/09 and asked to be gone. Only the one-shot join
 * uses this; the continuous SYNC loop stays on beat phase, whose half-beat
 * nudges can never push a bar-aligned join off by a whole beat.
 */
export function barPhaseDeltaSec(
  deckPositionSec: number,
  deckGrid: BeatGrid,
  masterPositionSec: number,
  masterGrid: BeatGrid,
): number {
  const deckBarSec = (60 / deckGrid.bpm) * BEATS_PER_BAR
  const masterBarSec = (60 / masterGrid.bpm) * BEATS_PER_BAR
  const deckPhase = frac01((deckPositionSec - deckGrid.offsetSec) / deckBarSec)
  const masterPhase = frac01((masterPositionSec - masterGrid.offsetSec) / masterBarSec)
  let diff = masterPhase - deckPhase
  diff -= Math.round(diff)
  return diff * deckBarSec
}

/**
 * How far past a loop's start a wrapped position can land and still count as
 * having just crossed the bar line the loop starts on — one audio frame is
 * ~16ms, a slow one several times that.
 */
const WRAP_CROSS_TOLERANCE_SEC = 0.1

/**
 * Did the deck pass a yellow (bar) line between two consecutive frames?
 * Moving forward: any line in (prevSec, posSec]. Jumping back (a loop wrap):
 * a 4-beat loop that starts on a yellow line *ends* on the next one, so the
 * position wraps just before ever reaching it — the line it musically hit is
 * the loop start it landed on, so a line just behind the new position
 * counts. Without this, waiting for "the next bar line" on a looping deck
 * never ended (v0.8.14 review).
 */
export function barLineCrossed(prevSec: number, posSec: number, grid: BeatGrid): boolean {
  if (posSec >= prevSec) return nextBarLineSec(prevSec, grid) <= posSec + 1e-9
  return nextBarLineSec(posSec - WRAP_CROSS_TOLERANCE_SEC, grid) <= posSec + 1e-9
}

/** First yellow (bar) line strictly after `positionSec` on `grid`. */
export function nextBarLineSec(positionSec: number, grid: BeatGrid): number {
  const barSec = (60 / grid.bpm) * BEATS_PER_BAR
  const barIndex = Math.floor((positionSec - grid.offsetSec) / barSec) + 1
  const line = grid.offsetSec + barIndex * barSec
  // (2.3 - 0.3) / 2 floors to 0.999… → the line just passed; step past it.
  return line <= positionSec + 1e-9 ? line + barSec : line
}

/** Corrects an octave-low BPM guess (the detector locked onto every other beat). */
export function halveGrid(grid: BeatGrid): BeatGrid {
  return { bpm: grid.bpm / 2, offsetSec: grid.offsetSec }
}

/**
 * One bar, in seconds — the period the three hand-edit functions below fold
 * `offsetSec` into. Folding into a *beat* (as they did until v0.8.23) keeps
 * where the beats fall but throws away which of them is the "1": "Set
 * downbeat here" on beat 3 folded back to beat 1 of the first bar, and the
 * yellow line stayed exactly where the owner had just said it was wrong.
 */
function barPeriodSec(bpm: number): number {
  return (60 / bpm) * BEATS_PER_BAR
}

/** Corrects an octave-high BPM guess (the detector locked onto a subdivision). */
export function doubleGrid(grid: BeatGrid): BeatGrid {
  const bpm = grid.bpm * 2
  return { bpm, offsetSec: foldInto(grid.offsetSec, barPeriodSec(bpm)) }
}

/** Nudge the grid's phase by `deltaSec`, wrapped back into one bar. */
export function shiftGrid(grid: BeatGrid, deltaSec: number): BeatGrid {
  return { bpm: grid.bpm, offsetSec: foldInto(grid.offsetSec + deltaSec, barPeriodSec(grid.bpm)) }
}

/** A new grid whose bar line (beat 0 of a bar) lands exactly at `markSec`, at the given `bpm`. */
export function setDownbeatAt(bpm: number, markSec: number): BeatGrid {
  return { bpm, offsetSec: foldInto(markSec, barPeriodSec(bpm)) }
}

/**
 * BPM from tap-tempo timestamps (seconds, e.g. `performance.now() / 1000`).
 * Uses the median inter-tap interval to reject one fat-fingered tap without
 * needing the caller to already know which one was bad, then averages whatever
 * intervals survive that filter. `null` until there are at least two taps to
 * form an interval from.
 */
export function bpmFromTaps(tapTimesSec: number[]): number | null {
  if (tapTimesSec.length < 2) return null
  const intervals: number[] = []
  for (let i = 1; i < tapTimesSec.length; i++) {
    const d = tapTimesSec[i] - tapTimesSec[i - 1]
    if (d > 0) intervals.push(d)
  }
  if (intervals.length === 0) return null
  const sorted = [...intervals].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const kept = intervals.filter((d) => Math.abs(d - median) / median < 0.3)
  const use = kept.length > 0 ? kept : intervals
  const mean = use.reduce((a, b) => a + b, 0) / use.length
  return Math.round((60 / mean) * 10) / 10
}
