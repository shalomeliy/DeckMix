/**
 * Hot-cue bank + temp cue point persistence (v0.4.0), keyed by content hash on
 * `idb-keyval`.
 *
 * One record per track on `idb-keyval`, the same per-key shape as
 * `analyze-cache-idb` and for the same reason: the library holds hundreds of
 * tracks, and a single shared blob rewritten on every cue edit would cost
 * O(library size) per write. Keyed by `contentHash`, not `Track.id` — the
 * whole point of this store (and of `analyze-cache-idb`/the genre-override
 * migration alongside it) is that a track's cues travel with the file even
 * after it moves to a different library folder, which a path-keyed store
 * cannot do (the v0.3.2 bug this fixes for cues too).
 */
import { get, set } from 'idb-keyval'
import type { HotCue } from '@/core/types'

const KEY_PREFIX = 'deckmix:cues:'

export interface StoredCues {
  hotCues: HotCue[]
  cuePointSec: number
}

/**
 * Never throws — a missing/blocked IndexedDB must not stop a track from
 * loading, only stop its cues from being remembered. `null` means "nothing
 * stored yet", the same as a fresh track.
 */
export async function getCues(contentHash: string): Promise<StoredCues | null> {
  try {
    const stored = await get<StoredCues>(KEY_PREFIX + contentHash)
    return stored ?? null
  } catch {
    return null
  }
}

/**
 * Throws on failure — same choice `genre-overrides-idb`/`analyze-cache-idb`
 * make — so the caller (`controls.ts`, the one place cues are edited) can
 * surface it rather than a cue that looks set but silently isn't saved.
 */
export async function putCues(contentHash: string, value: StoredCues): Promise<void> {
  await set(KEY_PREFIX + contentHash, value)
}
