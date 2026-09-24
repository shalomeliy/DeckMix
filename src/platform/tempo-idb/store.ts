/**
 * Per-track tempo-fader persistence (v0.8.6), keyed by content hash on
 * `idb-keyval` — same shape and reasoning as `cues-idb/store.ts`: the tempo
 * a DJ dials in for a track is something worth remembering the next time
 * that same track loads, and it has to travel with the file's bytes, not
 * its folder path (the v0.3.2 bug cues already fixed for exactly this
 * reason).
 */
import { get, set } from 'idb-keyval'

// `tempo2`, not `tempo`: until 20/09 a SYNC-derived offset was saved here too,
// so tracks came back at another song's pairing (e.g. pinned at +8%). Those old
// values can't be told apart from hand-set ones, so they are left orphaned
// rather than restored.
const KEY_PREFIX = 'deckmix:tempo2:'

/**
 * Never throws — a missing/blocked IndexedDB must not stop a track from
 * loading, only stop its tempo from being remembered. `null` means "nothing
 * stored yet" — the caller keeps whatever tempo the deck already had,
 * exactly like a physical pitch fader that doesn't move on its own when a
 * new record drops onto the platter.
 */
export async function getTempo(contentHash: string): Promise<number | null> {
  try {
    const stored = await get<number>(KEY_PREFIX + contentHash)
    return stored ?? null
  } catch {
    return null
  }
}

/**
 * Throws on failure — same choice `cues-idb`/`genre-overrides-idb` make, so
 * the caller can surface it instead of a tempo that looks remembered but
 * silently isn't.
 */
export async function putTempo(contentHash: string, tempo: number): Promise<void> {
  await set(KEY_PREFIX + contentHash, tempo)
}
