/**
 * Per-track tempo-fader persistence (v0.8.6), keyed by content hash on
 * `idb-keyval` — same shape and reasoning as `cues-idb/store.ts`: the tempo
 * a DJ dials in for a track is something worth remembering the next time
 * that same track loads, and it has to travel with the file's bytes, not
 * its folder path (the v0.3.2 bug cues already fixed for exactly this
 * reason).
 */
import { del, get } from 'idb-keyval'

// v0.9.47: read only, to carry a v0.9.46 value over to `TrackMeta.playRate` (`loadPlayRate`) — nothing writes here any more.
// `tempo3` (v0.9.46): written only when the owner pressed "Save tempo". Until
// then `tempo2` saved every hand move of the fader, and Shalom did not want a
// speed remembered without being asked (06/10). Those values can't be told
// apart from ones he would have chosen, so — like `tempo` before them — they
// are left orphaned, not restored and not deleted.
// `tempo2`, not `tempo`: until 20/09 a SYNC-derived offset was saved there too.
const KEY_PREFIX = 'deckmix:tempo3:'

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

/** Removes a v0.9.46 value once `loadPlayRate` has carried it over to `TrackMeta.playRate`. Throws on failure. */
export async function clearTempo(contentHash: string): Promise<void> {
  await del(KEY_PREFIX + contentHash)
}
