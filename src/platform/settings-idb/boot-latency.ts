/**
 * The one setting that has to be readable before the settings store exists.
 *
 * `AudioContext` takes `latencyHint` at construction and offers no way to
 * change it afterwards, and the engine builds its context when its module is
 * first imported — long before `settings.init()` has finished asking IndexedDB
 * anything. Reading `settings.values.latency` there would always have returned
 * the default, so the field would have looked settable and never applied: a
 * control that does nothing, which is the exact failure this project forbids.
 *
 * So this value, and only this value, is mirrored into `localStorage`, which
 * answers synchronously. IndexedDB stays the source of truth; the mirror is
 * written on every change and is only ever read at construction time.
 *
 * **A second copy of a setting is a real cost** — it is the drift v0.2.5 was
 * partly written to end. It is accepted here because the platform gives no
 * alternative, and it is confined to one named key in one file so that the
 * exception stays visible instead of becoming a pattern.
 */
import type { LatencyProfile } from '@/core/settings'

export const BOOT_LATENCY_KEY = 'deckmix:bootLatency'

const HINTS: Record<LatencyProfile, AudioContextLatencyCategory> = {
  interactive: 'interactive',
  balanced: 'balanced',
  playback: 'playback',
}

/** What the AudioContext should be built with on this load. */
export function bootLatencyHint(): AudioContextLatencyCategory {
  try {
    const stored = localStorage.getItem(BOOT_LATENCY_KEY)
    if (stored && stored in HINTS) return HINTS[stored as LatencyProfile]
  } catch {
    // Blocked storage throws rather than returning null. The tightest setting
    // is also the default, so there is nothing to report here.
  }
  return 'interactive'
}

export function writeBootLatency(profile: LatencyProfile): void {
  try {
    localStorage.setItem(BOOT_LATENCY_KEY, profile)
  } catch {
    // The settings store already reports a failed write; a second message
    // about the same failure would only say it twice.
  }
}
