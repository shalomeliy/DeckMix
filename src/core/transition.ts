import { BEATS_PER_BAR, barPhaseDeltaSec } from '@/core/beatgrid'
import type { BeatGrid } from '@/core/types'

/**
 * Pure math for the autonomous Mix Assist transition (v0.4.6): the crossfade
 * curve and the one-shot phase-join seek offset. Everything here is a plain
 * function of numbers — no `AudioContext`, no store, no timers — so it can be
 * unit-tested without a running engine, the same split `core/beatgrid.ts`
 * already made for phase math.
 */

export interface CrossfadeGains {
  /** gain for the deck the transition starts from */
  fromGain: number
  /** gain for the deck the transition moves to */
  toGain: number
}

/**
 * Equal-power crossfade at `progress` (0 = fully on the "from" deck, 1 =
 * fully on the "to" deck) — the same cosine law as
 * `platform/audio-webaudio/engine.ts`'s `setCrossfader`, so an autonomous
 * transition sounds like the same crossfader the user's hand already knows,
 * not a second, different-feeling fade.
 */
export function crossfadeGains(progress: number): CrossfadeGains {
  const t = Math.min(1, Math.max(0, progress))
  return {
    fromGain: Math.cos((t * Math.PI) / 2),
    toGain: Math.sin((t * Math.PI) / 2),
  }
}

/** Elapsed time as a 0..1 progress fraction of a fixed-duration crossfade. */
export function crossfadeProgress(elapsedSec: number, durationSec: number): number {
  if (durationSec <= 0) return 1
  return Math.min(1, Math.max(0, elapsedSec / durationSec))
}

/**
 * Where to actually start (seek) the incoming deck so that, played from
 * there, its beat phase already matches the outgoing/master deck's phase at
 * this instant — "seek-then-sync" (ROADMAP.md v0.4.6): the join happens
 * while the incoming deck is still inaudible (full crossfade on the outgoing
 * side), so this one silent seek replaces relying on the ongoing sync loop
 * (`controls.ts`'s `ensureSyncLoop`) to converge from a cold, unaligned
 * start — its constants are tuned for small continuous drift, not a fresh
 * join (see `HANDOFF.md`'s note on `MAX_SYNC_BEND` being unmeasured for this).
 *
 * Aligned to the *bar*, not just the beat (v0.8.14, owner review 23/09):
 * `barPhaseDeltaSec` moves the entry at most half a bar so the incoming
 * deck's yellow line lands on the master's. Beat-only alignment (what this
 * was until then) kept every white line matched while the yellow lines could
 * sit one to three beats apart — a mix that is "in time" and still starts
 * on the wrong beat of the bar. Paired with `startAutoTransition` waiting for
 * the master's next yellow line, the join lands yellow-on-yellow.
 *
 * A result before the track's start is pushed one bar later — seeking to a
 * negative time would silently clamp to 0 and lose the alignment.
 */
export function phaseAlignedEntrySec(
  entrySec: number,
  incomingGrid: BeatGrid,
  masterPositionSec: number,
  masterGrid: BeatGrid,
): number {
  const sec = entrySec + barPhaseDeltaSec(entrySec, incomingGrid, masterPositionSec, masterGrid)
  return sec < 0 ? sec + (60 / incomingGrid.bpm) * BEATS_PER_BAR : sec
}

/**
 * Where the outgoing deck stands against a remembered exit second (v0.8.16).
 * `exitSec` is where the outgoing deck actually was when an excellent-rated
 * mix joined — itself a bar line, since the join always waits for one. On a
 * replay the join fires on the first bar line crossed while `'due'`.
 *
 * The window is asymmetric on purpose: half a bar before, a whole bar after.
 * 1.5 bars always holds at least one bar line, so a grid nudged since the
 * pair was saved still lands a join instead of sliding the deck straight
 * from `'early'` to `'passed'` without ever being `'due'` on a line.
 * `barSec` is in track seconds, same clock as both positions.
 */
export type ExitWaitStatus = 'early' | 'due' | 'passed'

export function exitWaitStatus(positionSec: number, exitSec: number, barSec: number): ExitWaitStatus {
  if (positionSec > exitSec + barSec) return 'passed'
  if (positionSec >= exitSec - barSec / 2) return 'due'
  return 'early'
}
