import type { DeckId } from '@/core/types'

/**
 * v0.8.39 — "the incoming track comes in on SYNC, then slowly goes back to its
 * own BPM" (Shalom, 25/09). Without the glide, a track synced in stays at the
 * outgoing track's tempo for its whole length, and the next one inherits it:
 * over a set, every track drifts away from the speed it was made at.
 */

/** Shalom's choice (25/09): slow enough that a dance floor barely notices. */
export const GLIDE_BACK_SEC = 30

/**
 * Below this a channel counts as off. Not zero: a fader pulled "all the way
 * down" by hand, or by MIDI, often lands a step above it — and a track that is
 * inaudible but not exactly silent must still count as gone, or the glide
 * never starts and nothing on screen says why.
 */
const SILENT_LEVEL = 0.02

export interface MasterAudibility {
  playing: boolean
  /** the master deck's channel fader, 0..1 */
  channelVolume: number
  /** -1 (A only) .. +1 (B only) */
  crossfader: number
}

/**
 * Whether the deck a synced track follows has gone — "when the old song is
 * over" in Shalom's words. Stopped, faded out on its channel, or crossfaded
 * fully away all mean the same thing on the floor: only the synced track is
 * heard, so there is nothing left to keep its tempo matched to.
 */
export function masterHasGone(masterId: DeckId, m: MasterAudibility): boolean {
  if (!m.playing) return true
  if (m.channelVolume < SILENT_LEVEL) return true
  const awayFromMaster = masterId === 'A' ? m.crossfader : -m.crossfader
  return awayFromMaster >= 1 - SILENT_LEVEL
}

/** Tempo fader value `elapsedSec` into a straight-line glide. Clamped both ends so a late or early tick never overshoots. */
export function glideTempoAt(fromTempo: number, toTempo: number, elapsedSec: number, durationSec: number): number {
  if (durationSec <= 0 || elapsedSec >= durationSec) return toTempo
  if (elapsedSec <= 0) return fromTempo
  return fromTempo + ((toTempo - fromTempo) * elapsedSec) / durationSec
}
