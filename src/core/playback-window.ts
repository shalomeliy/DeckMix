/**
 * Where a stretch of a track that was scheduled on the audio clock is "now" (v0.9.11). Pure arithmetic, kept out of the
 * Web Audio player so a test can reach it: the player's own file cannot be built under the test tsconfig (no DOM types).
 * The vocal clip's progress line was `null` for as long as the clip was played without recording this window.
 */
export interface PlaybackWindow {
  /** Audio-clock time the sound starts. */
  when: number
  /** Where in the track it starts. */
  startSec: number
  len: number
}

export function clipWindow(now: number, leadSec: number, startSec: number, lenSec: number, trackSec: number): PlaybackWindow {
  return { when: now + leadSec, startSec, len: Math.max(0, Math.min(lenSec, trackSec - startSec)) }
}

/** Seconds into the track, or `null` before anything was scheduled or after the stretch has ended. */
export function windowPosition(w: PlaybackWindow | null, now: number): number | null {
  if (!w) return null
  const t = now - w.when
  if (t > w.len) return null
  return w.startSec + Math.max(0, t)
}
