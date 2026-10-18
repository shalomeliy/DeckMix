/**
 * v0.9.69 experiment: how far the analyzer's beat grid is from the one the owner fixed by hand, song by song.
 *
 * Only songs he corrected can be compared (a song he never opened has no hand grid), so every number here is "of the songs he
 * corrected" — a lower bound on how often the analyzer is off, never the rate over the whole library. The summary says so.
 *
 * The cached detection is the BEAT grid only: the bar line ("1") is guessed from the audio at load time and not cached
 * (`core/downbeat.ts`), so this cannot judge the "1". `beatsFromFirst` is the one hint: 0 means his "1" is the detected first beat.
 */
import type { BeatGrid } from '@/core/types'

/** A song is "drifting" past this many ms of beat-position error (the criterion in docs/handoff/v0.9.69.md). */
export const DRIFT_LIMIT_MS = 25
/** The share of corrected songs that may be off before a marking flow is worth building. */
export const FAIL_SHARE_LIMIT = 0.15
/** Fewer comparable songs than this and the verdict says "not enough data" instead of a percentage. */
export const MIN_COMPARABLE = 10

export type DriftVerdict = 'ok' | 'drift' | 'octave' | 'differs' | 'no-detection'

export interface DriftInput {
  contentHash: string
  name: string | null
  hand: BeatGrid & { tempoByHand: boolean }
  /** The analyzer's grid for the same bytes; null = nothing cached for the current analyzer version. */
  detected: BeatGrid | null
  durationSec: number | null
}

export interface DriftRow extends DriftInput {
  verdict: DriftVerdict
  /** Beat-position error at the start and at the end of the song (the end is not folded, so a tempo gap adding up to whole beats still shows); null when not comparable. */
  startErrMs: number | null
  endErrMs: number | null
  worstMs: number | null
  /** Beats from the detected first beat to his first beat, mod 4. */
  beatsFromFirst: number | null
}

/** Beats between the two grids at time t, NOT folded: a tempo gap that adds up to whole beats must not read as zero. */
function rawDiffBeats(t: number, hand: BeatGrid, det: BeatGrid): number {
  return (t - hand.offsetSec) / (60 / hand.bpm) - (t - det.offsetSec) / (60 / det.bpm)
}

export function compareGrid(input: DriftInput): DriftRow {
  const { hand, detected } = input
  const none = { startErrMs: null, endErrMs: null, worstMs: null, beatsFromFirst: null }
  if (!detected || !(detected.bpm > 0)) return { ...input, verdict: 'no-detection', ...none }
  const ratio = hand.bpm / detected.bpm
  const beatsFromFirst = (((Math.round((hand.offsetSec - detected.offsetSec) / (60 / detected.bpm)) % 4) + 4) % 4)
  if (Math.abs(ratio - 1) > 0.02) {
    const octave = Math.abs(ratio / 2 - 1) <= 0.02 || Math.abs(ratio * 2 - 1) <= 0.02
    return { ...input, verdict: octave ? 'octave' : 'differs', ...none, beatsFromFirst }
  }
  // Without a duration the end of the song cannot be measured, and a start-only "ok" would hide a tempo gap: not comparable.
  if (!(input.durationSec != null && input.durationSec > 0)) return { ...input, verdict: 'no-detection', ...none, beatsFromFirst }
  // The whole-beat part at the start is his "1" being elsewhere (beatsFromFirst), not an error; only what is left over counts.
  const k = Math.round(rawDiffBeats(0, hand, detected))
  const msPerBeat = (60 / hand.bpm) * 1000
  const startErrMs = (rawDiffBeats(0, hand, detected) - k) * msPerBeat
  const endErrMs = (rawDiffBeats(input.durationSec, hand, detected) - k) * msPerBeat
  const worstMs = Math.max(Math.abs(startErrMs), Math.abs(endErrMs))
  return { ...input, verdict: worstMs > DRIFT_LIMIT_MS ? 'drift' : 'ok', startErrMs, endErrMs, worstMs, beatsFromFirst }
}

export interface DriftSummary {
  corrected: number
  noDetection: number
  comparable: number
  ok: number
  drift: number
  octave: number
  differs: number
  /** (drift + octave + differs) / comparable; null with no comparable songs. */
  offShare: number | null
  /** Of the comparable songs, how many have his "1" on the detected first beat. */
  firstBeatIsOne: number
  verdict: 'build-marking' | 'improve-detection' | 'not-enough-data'
}

export function summarizeDrift(rows: DriftRow[]): DriftSummary {
  const count = (v: DriftVerdict) => rows.filter((r) => r.verdict === v).length
  const noDetection = count('no-detection')
  const comparable = rows.length - noDetection
  const ok = count('ok')
  const drift = count('drift')
  const octave = count('octave')
  const differs = count('differs')
  const off = drift + octave + differs
  const offShare = comparable > 0 ? off / comparable : null
  return {
    corrected: rows.length,
    noDetection,
    comparable,
    ok,
    drift,
    octave,
    differs,
    offShare,
    firstBeatIsOne: rows.filter((r) => r.verdict !== 'no-detection' && r.beatsFromFirst === 0).length,
    verdict: comparable < MIN_COMPARABLE || offShare == null ? 'not-enough-data' : offShare > FAIL_SHARE_LIMIT ? 'build-marking' : 'improve-detection',
  }
}

export function gridCheckExportText(rows: DriftRow[], nowMs: number): string {
  return JSON.stringify({ schema: 1, kind: 'deckmix-grid-check', exportedAt: new Date(nowMs).toISOString(), summary: summarizeDrift(rows), rows }, null, 2)
}
