/**
 * "This exit point worked" memory (v0.5.4), keyed by content hash on
 * `idb-keyval` — same one-record-per-track shape as `cues-idb`, and for the
 * same reason: a track's remembered good exit points travel with the file
 * even after it moves to a different library folder.
 *
 * Only "excellent" is ever stored. The rating prompt also offers "bad" and
 * "needs work", but nothing downstream reads those back — there is no
 * behaviour yet that would use a *negative* memory, and inventing storage
 * for it now would be exactly the kind of unused, unverifiable feature this
 * project avoids. Seconds are rounded before keying so a point matches
 * whichever nearby candidate `findTransitionCandidates` re-finds on a later
 * analysis, which won't reproduce the exact same float twice.
 */
import { get, set } from 'idb-keyval'

const KEY_PREFIX = 'deckmix:mixratings:'

/**
 * Never throws — a missing/blocked IndexedDB must not stop a track from
 * loading, only stop its remembered points from showing up. An empty array
 * means the same thing as "nothing rated yet".
 */
export async function getExcellentPoints(contentHash: string): Promise<number[]> {
  try {
    return (await get<number[]>(KEY_PREFIX + contentHash)) ?? []
  } catch {
    return []
  }
}

/**
 * Throws on failure, same choice `cues-idb`/`genre-overrides-idb` make — the
 * one call site (`controls.ts`'s rating handler) can surface it rather than a
 * "marked excellent" confirmation that silently didn't save.
 */
export async function markExcellent(contentHash: string, sec: number): Promise<void> {
  const rounded = Math.round(sec)
  const existing = await getExcellentPoints(contentHash)
  if (existing.includes(rounded)) return
  await set(KEY_PREFIX + contentHash, [...existing, rounded])
}
