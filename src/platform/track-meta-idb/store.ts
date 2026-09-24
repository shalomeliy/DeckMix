/**
 * Per-track note and last-played timestamp (v0.8.0), on `idb-keyval`.
 *
 * Same shape as `genre-overrides-idb/store.ts`'s hash-keyed store: one
 * record per track, keyed by content hash — not `id` (a scan-relative
 * path, unstable across rescans/renames) — so a note or a play stamp
 * survives the file turning up in a different folder later. Unlike genre,
 * there is no legacy path-keyed predecessor to migrate from; this store
 * started hash-keyed.
 */
import { get, set } from 'idb-keyval'

const KEY = 'deckmix:trackMeta'

export interface TrackMeta {
  note?: string
  lastPlayedAt?: number
}

/**
 * All stored track meta, `contentHash -> TrackMeta`. Never throws — a
 * missing/blocked IndexedDB must not stop the library from loading, only
 * stop notes/last-played from showing up. An empty map means the same
 * thing as "nothing stored yet".
 */
export async function getTrackMetaByHash(): Promise<Map<string, TrackMeta>> {
  try {
    const stored = await get<Record<string, TrackMeta>>(KEY)
    return new Map(Object.entries(stored ?? {}))
  } catch {
    return new Map()
  }
}

/**
 * Persist a note, keyed by content hash. Throws on failure so the caller
 * (`controls.ts`, the one place user actions are dispatched from) can
 * surface it — swallowing it here would mean an edit that looks saved but
 * silently is not. Merges onto whatever is already stored for this hash
 * (e.g. a `lastPlayedAt` from an earlier load) rather than replacing it.
 */
export async function setTrackNote(contentHash: string, note: string): Promise<void> {
  const stored = await get<Record<string, TrackMeta>>(KEY)
  await set(KEY, { ...(stored ?? {}), [contentHash]: { ...stored?.[contentHash], note } })
}

/**
 * Stamp the moment a track was last loaded to a deck. Same throws-on-
 * failure contract as `setTrackNote` — the one call site
 * (`controls.ts`'s `loadTrackToDeck`) treats a failure here as
 * non-fatal to the load itself (the track still plays), same as a hash
 * failure already does.
 */
export async function setLastPlayed(contentHash: string, ts: number): Promise<void> {
  const stored = await get<Record<string, TrackMeta>>(KEY)
  await set(KEY, { ...(stored ?? {}), [contentHash]: { ...stored?.[contentHash], lastPlayedAt: ts } })
}
