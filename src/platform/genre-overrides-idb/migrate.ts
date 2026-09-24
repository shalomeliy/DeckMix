/**
 * One-time migration (v0.4.0): re-keys the v0.3.2 path-keyed genre overrides
 * under content hash, in `genre-overrides-idb/store.ts`'s new `HASH_KEY`
 * store. Non-destructive — Risk 3 in `workshop-output/PLAN.md`'s own stated
 * rollback: this only ever reads the old store, never writes or deletes it,
 * so a bad migration can be re-run (once the guard flag below is cleared)
 * without losing the original data.
 *
 * Only migrates entries whose path still matches a track in *this* scan — a
 * file that already moved before this runs has nothing here to key its old
 * override to, and stays exactly the known, accepted debt named in
 * `HANDOFF.md`'s "עריכת ז'אנר ידנית אובדת בשקט" line. What this fixes is
 * forward-looking: an override still correctly matched today survives every
 * move from here on, because it now travels by content, not path.
 */
import { get, set } from 'idb-keyval'
import { getGenreOverrides, setGenreOverrideByHash } from '@/platform/genre-overrides-idb/store'
import { hashFile } from '@/platform/source-fsaccess/hash'
import type { Track } from '@/core/types'

const MIGRATED_KEY = 'deckmix:genreOverrides:migratedToHash'

export interface MigrationResult {
  /** entries successfully re-keyed under content hash */
  migrated: number
  /** entries with no matching current track, or unreadable — could not be re-keyed */
  orphaned: number
}

/**
 * Runs once per browser profile, guarded by `MIGRATED_KEY` — every later
 * scan is a no-op read of that flag (returns `null`, nothing to report), not
 * a re-walk of the override map. Call with the tracks from a completed scan,
 * so `track.handle` is real and a hash can actually be computed.
 *
 * Returns a count rather than silently finishing — every other "some entries
 * couldn't be carried forward" case in this app (skipped files, unreadable
 * files, unrecognized genre folders) is a named, counted fact the owner can
 * see; a migration that drops entries with no report at all would be the one
 * exception to that rule. The caller (`Library.tsx`) surfaces `orphaned > 0`
 * through the existing notice banner.
 */
export async function migrateGenreOverridesToHash(tracks: Track[]): Promise<MigrationResult | null> {
  if (await get<boolean>(MIGRATED_KEY)) return null
  const overrides = await getGenreOverrides()
  if (overrides.size === 0) {
    await set(MIGRATED_KEY, true)
    return { migrated: 0, orphaned: 0 }
  }
  const byId = new Map(tracks.map((t) => [t.id, t]))
  let migrated = 0
  let orphaned = 0
  for (const [trackId, genre] of overrides) {
    const track = byId.get(trackId)
    if (!track) {
      orphaned++ // no current track at that path — nothing to re-key
      continue
    }
    try {
      const hash = await hashFile(track.handle)
      await setGenreOverrideByHash(hash, genre)
      migrated++
    } catch {
      // File vanished or became unreadable between the scan and here — best
      // effort per entry, the same "one bad file never stalls the rest"
      // rule the analysis queue follows.
      orphaned++
    }
  }
  await set(MIGRATED_KEY, true)
  return { migrated, orphaned }
}
