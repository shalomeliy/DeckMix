/**
 * Beat-grid corrections (v0.8.23), keyed by content hash on `idb-keyval` —
 * the same shape as `cues-idb/store.ts`, and under its own `deckmix:` key
 * rather than inside `analyze-cache-idb`, which is emptied on every analyzer
 * version bump (`core/grid-corrections.ts` says why that matters).
 */
import { get, set } from 'idb-keyval'
import type { GridCorrection } from '@/core/grid-corrections'

const KEY_PREFIX = 'deckmix:gridCorrection:'

/**
 * Returns the raw stored value, unvalidated — `resolveGridCorrection` decides
 * whether it is usable. Throws on a blocked IndexedDB so the caller can say
 * the saved grid could not be read, instead of silently showing the detected
 * one as if no correction existed.
 */
export async function getGridCorrection(contentHash: string): Promise<unknown> {
  return get(KEY_PREFIX + contentHash)
}

/** Throws on failure, like `putCues` — the caller surfaces it. */
export async function putGridCorrection(contentHash: string, value: GridCorrection): Promise<void> {
  await set(KEY_PREFIX + contentHash, value)
}
