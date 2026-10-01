/**
 * Which beat of a detected grid is the "1" (v0.9.5). The beat grid finds beats,
 * not bars (`estimateBeatGrid` folds onsets over one beat), so until now the
 * "1" was simply the first beat of the track — right on 79% of the owner's
 * dance songs, because most DJ edits start on a bar line.
 *
 * The cue that measured best (scripts/experiment-downbeat.mjs, 28/09): the
 * moment the kick comes back after a stretch without it. Drops, breaks ending
 * and new sections land on a bar line, and in dance music the kick is what
 * returns there. Chord change, spectral flux and cymbal hits were all tried
 * and were weaker. Read at half-beat resolution because the owner's rule
 * (28/09): when the kick sits half-way between two lines, the "1" is the beat
 * *before* it — PINKED PANTHER's drop kick lands on beat 239.5, his "1" is 239.
 *
 * Measured on songs the method was never tuned on (House/Techno/Trance, after
 * the owner's listening rounds): 53/61 right against 48/61 for the first beat;
 * when `sure`, 45/47. The goal was 95% overall and is not reached. An answer
 * that is not `sure` still moves the grid — it beat the first beat on those
 * songs (`chooseBarGrid`) — but the deck shows it as unsure: dashed bar lines
 * and a "bar 1 unsure" badge. Do not make unsure answers keep the first beat
 * without measuring again: that is the 48, not the 53.
 *
 * Not the rule "kick one beat before a snare starts the bar": that is
 * AlphaTheta's US11176915B2, in force until 2037 (ROADMAP.md v0.9.5).
 */
import type { BeatGrid } from '@/core/types'
import { BEATS_PER_BAR, shiftGrid } from '@/core/beatgrid'

export interface BarOne {
  /** Beat (0–3) of the grid, counted from its `offsetSec`, that is the "1". */
  beat: number
  /** Winner's score minus the runner-up's, 0…1.3. */
  margin: number
  /** `margin >= SURE_MARGIN`. Unsure answers still move the grid, shown as unsure — see the file comment. */
  sure: boolean
}

/** ±this around a beat is "on" it — a 5 ms frame's grid sits within a frame or two of the kick. */
const ON_BEAT_SEC = 0.025
/** Half-beats compared on each side of a candidate entry: 16 = 8 beats = 2 bars. */
const ENTRY_WINDOW = 16
/** Entries that vote. More than this and the intro's noise starts to count. */
const TOP_ENTRIES = 8
/** Two entries closer than this (in half-beats — 4 bars) are one section change. */
const ENTRY_GAP = 32
/** Pull toward "the first beat", the old answer, when the kick says little. */
const FIRST_BEAT_PRIOR = 0.3
/** Training: 33/34 right above it on dance songs; the unseen songs: 45/47. */
export const SURE_MARGIN = 0.4

/**
 * `low` is the kick envelope — RMS below ~150 Hz, `perSec` values a second —
 * from `kickEnvelope` (platform/analyzer-js/beat.ts) on the decoded track.
 * Not the cached waveform's low band: that one splits at 200 Hz and measured
 * 50/61 against this one's 53/61. `null` when the track is too short or silent.
 */
export function detectBarOne(low: ArrayLike<number>, perSec: number, grid: BeatGrid): BarOne | null {
  const beatSec = 60 / grid.bpm
  const n = low.length
  const rise = (sec: number): number => {
    const c = Math.round(sec * perSec)
    const w = Math.max(1, Math.round(ON_BEAT_SEC * perSec))
    let best = 0
    for (let j = Math.max(1, c - w); j <= Math.min(n - 1, c + w); j++) best = Math.max(best, low[j] - low[j - 1])
    return best
  }
  const beats = Math.floor((n / perSec - grid.offsetSec) / beatSec)
  if (beats < 2 * ENTRY_WINDOW) return null
  // Kick rise on every half-beat: even = on the beat, odd = half-way to the next.
  const x = new Float64Array(2 * beats)
  for (let k = 0; k < beats; k++) {
    const t = grid.offsetSec + k * beatSec
    x[2 * k] = rise(t)
    x[2 * k + 1] = rise(t + beatSec / 2)
  }
  const sorted = Float64Array.from(x).sort()
  const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))]
  if (!(p90 > 0)) return null
  for (let i = 0; i < x.length; i++) x[i] /= p90

  // An entry: the next 2 bars have more kick than the 2 before, and this
  // half-beat is where it jumps.
  const mean = (a: number, b: number) => {
    let s = 0
    for (let i = a; i < b; i++) s += x[i]
    return s / (b - a)
  }
  const score: [number, number][] = []
  for (let k = ENTRY_WINDOW; k + ENTRY_WINDOW <= x.length; k++) {
    const r = mean(k, k + ENTRY_WINDOW) - mean(k - ENTRY_WINDOW, k)
    const jump = x[k] - Math.max(x[k - 1], x[k - 2])
    if (r > 0 && jump > 0) score.push([r * jump, k])
  }
  score.sort((a, b) => b[0] - a[0])
  const votes = [0, 0, 0, 0]
  const taken: number[] = []
  for (const [s, k] of score) {
    if (taken.length >= TOP_ENTRIES) break
    if (taken.some((j) => Math.abs(j - k) < ENTRY_GAP)) continue
    taken.push(k)
    votes[Math.floor(k / 2) % BEATS_PER_BAR] += s // k+½ votes for k: the beat before
  }
  const total = votes.reduce((a, b) => a + b, 0) || 1
  const s = votes.map((v, p) => v / total + (p === 0 ? FIRST_BEAT_PRIOR : 0))
  const order = [0, 1, 2, 3].sort((a, b) => s[b] - s[a])
  const margin = s[order[0]] - s[order[1]]
  return { beat: order[0], margin, sure: margin >= SURE_MARGIN }
}

/**
 * A "1" only means something on the beats it was measured on. When a file's
 * BPM tag overrode the detected tempo (an octave miss, `labelAgrees` in
 * controls.ts), the deck's beats are not those beats.
 */
export function barOneApplies(deckGrid: BeatGrid | null, measuredOn: BeatGrid | null): boolean {
  return deckGrid != null && measuredOn != null && Math.abs(deckGrid.bpm - measuredOn.bpm) < 0.05
}

/**
 * The grid a deck gets, and whether its "1" is shown as unsure. The owner's
 * saved grid wins outright (he checked it). Otherwise the detected grid moves
 * to the detected "1" — sure or not, see the file comment — and is unsure
 * unless `barOne.sure`; with no `barOne` at all (too short, no kick envelope,
 * a tag-overridden tempo) it keeps its first beat, also unsure.
 */
export function chooseBarGrid(
  detected: BeatGrid | null,
  barOne: BarOne | null,
  corrected: BeatGrid | null,
): { beatGrid: BeatGrid | null; barOneUnsure: boolean } {
  if (corrected) return { beatGrid: corrected, barOneUnsure: false }
  if (!detected) return { beatGrid: null, barOneUnsure: false }
  if (!barOne) return { beatGrid: detected, barOneUnsure: true }
  return { beatGrid: shiftGrid(detected, (barOne.beat * 60) / detected.bpm), barOneUnsure: !barOne.sure }
}
