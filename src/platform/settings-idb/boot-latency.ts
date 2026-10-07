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
import { analysisFingerprint, bootLatency } from '@/core/analysis-latency'
import { ANALYZER_VERSION } from '@/platform/analyze-cache-idb/version'
import { EMBEDDER_VERSION } from '@/platform/embed-cache-idb/version'
import { VOCAL_STRIP_VERSION } from '@/platform/vocal-strip-idb/store'

export const BOOT_LATENCY_KEY = 'deckmix:bootLatency'

const HINTS: Record<LatencyProfile, AudioContextLatencyCategory> = {
  interactive: 'interactive',
  balanced: 'balanced',
  playback: 'playback',
}

/** What the AudioContext should be built with on this load. */
export function bootLatencyHint(): AudioContextLatencyCategory {
  let stored: LatencyProfile | null = null
  let settled: string | null = null
  try {
    const raw = localStorage.getItem(BOOT_LATENCY_KEY)
    if (raw && raw in HINTS) stored = raw as LatencyProfile
    settled = localStorage.getItem(ANALYSIS_SETTLED_KEY)
  } catch {
    // Blocked storage throws rather than returning null. Read as "nothing
    // stored": the owner's default, cushioned because nothing says the
    // analysis ever finished — the safe side for the sound.
  }
  const boot = bootLatency(stored, settled, CURRENT_ANALYSIS)
  cushioned = boot.cushioned
  return HINTS[boot.hint]
}

/**
 * v0.9.52: the second key in this file, for the same reason as the first — it decides `latencyHint`, which has to be known before
 * IndexedDB answers. It holds the analysis versions (`core/analysis-latency.ts`) the library last finished every pass with.
 */
export const ANALYSIS_SETTLED_KEY = 'deckmix:analysisSettled'

const CURRENT_ANALYSIS = analysisFingerprint({ analyzer: ANALYZER_VERSION, embedder: EMBEDDER_VERSION, vocal: VOCAL_STRIP_VERSION })

let cushioned = false
/** True when this page's sound was built with the analysis cushion rather than the owner's own setting. */
export function latencyCushioned(): boolean {
  return cushioned
}

/** Every background pass finished on this page: the next load goes back to the owner's own setting. False: it could not be written, and the library says so. */
export function markAnalysisSettled(): boolean {
  try {
    localStorage.setItem(ANALYSIS_SETTLED_KEY, CURRENT_ANALYSIS)
    return true
  } catch {
    return false
  }
}

export function writeBootLatency(profile: LatencyProfile): void {
  try {
    localStorage.setItem(BOOT_LATENCY_KEY, profile)
  } catch {
    // The settings store already reports a failed write; a second message
    // about the same failure would only say it twice.
  }
}

/**
 * v0.9.53: the automatic refresh out of the cushion happens at most once per tab. `sessionStorage` lives exactly that long and survives
 * the reload, so the next page knows it was refreshed on purpose (and says so) and never refreshes again on its own — a loop is impossible
 * even if the settled mark somehow does not stick.
 */
const CUSHION_RELOAD_KEY = 'deckmix:cushionReloaded'

export function cushionReloadedThisTab(): boolean {
  try {
    return sessionStorage.getItem(CUSHION_RELOAD_KEY) != null
  } catch {
    return true // cannot remember it, so never refresh unattended: the button stays
  }
}

/** True exactly once, on the page the automatic refresh produced: that page says on screen why it was refreshed. */
export function justReloadedForCushion(): boolean {
  try {
    if (sessionStorage.getItem(CUSHION_RELOAD_KEY) !== '1') return false
    sessionStorage.setItem(CUSHION_RELOAD_KEY, 'said')
    return true
  } catch {
    return false
  }
}

/** False when the marker cannot be written — then no automatic refresh happens at all. */
export function markCushionReload(): boolean {
  try {
    sessionStorage.setItem(CUSHION_RELOAD_KEY, '1')
    return true
  } catch {
    return false
  }
}
