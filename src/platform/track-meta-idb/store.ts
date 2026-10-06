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
import { get, set, update } from 'idb-keyval'
import type { OwnerTempoKey } from '@/core/tag-merge'

const KEY = 'deckmix:trackMeta'

export interface TrackMeta {
  note?: string
  lastPlayedAt?: number
  /** v0.8.38: BPM/key the owner typed from the "check against Beatport" panel — see `applyOwnerMeta`. */
  owner?: OwnerTempoKey
  /** v0.9.41: the artist the owner accepted from a suggestion — see `applyOwnerArtist`. */
  artist?: string
  /** v0.9.41: suggestions he rejected for this track, as written. */
  artistRejected?: string[]
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
    live = new Map(Object.entries(stored ?? {}))
  } catch {
    live = new Map()
  }
  return live
}

/**
 * The map the last `getTrackMetaByHash` returned, kept in step with owner
 * BPM/key edits (v0.8.38). The Library's analysis pass reads it once at scan
 * start and merges from it for the whole scan; without this, a value the owner
 * typed — or took back — mid-scan was undone by that pass's stale copy.
 */
let live: Map<string, TrackMeta> | null = null

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

/**
 * The owner's own BPM/key for a track (v0.8.38). `undefined` for a field
 * removes it ("back to original"); a record left with no field is removed
 * whole. `update` rather than the get-then-set the two setters above use: a
 * load stamping `lastPlayedAt` in the same instant would otherwise drop one of
 * the two writes. Throws on failure, same contract as `setTrackNote`.
 */
export async function setOwnerTempoKey(contentHash: string, patch: OwnerTempoKey, clear: { bpm?: boolean; key?: boolean } = {}): Promise<void> {
  let written: TrackMeta | null = null
  await update<Record<string, TrackMeta>>(KEY, (stored) => {
    const all = { ...(stored ?? {}) }
    const meta = { ...all[contentHash] }
    const owner: OwnerTempoKey = { ...meta.owner, ...patch }
    if (clear.bpm) delete owner.bpm
    if (clear.key) {
      delete owner.key
      delete owner.camelot
    }
    if (owner.bpm == null && !owner.key && !owner.camelot) delete meta.owner
    else meta.owner = owner
    all[contentHash] = meta
    written = meta
    return all
  })
  if (live && written) live.set(contentHash, written)
}

/**
 * The owner's answer to an artist suggestion (v0.9.41): `accept` keeps it as
 * this track's artist, `reject` adds it to the ones never offered again.
 * `update`, like `setOwnerTempoKey`, so a play stamp landing in the same
 * instant is not lost. Throws on failure, same contract as `setTrackNote`.
 */
export async function setOwnerArtist(contentHash: string, answer: { accept: string } | { reject: string }): Promise<void> {
  let written: TrackMeta | null = null
  await update<Record<string, TrackMeta>>(KEY, (stored) => {
    const all = { ...(stored ?? {}) }
    const meta = { ...all[contentHash] }
    if ('accept' in answer) meta.artist = answer.accept
    else meta.artistRejected = [...new Set([...(meta.artistRejected ?? []), answer.reject])]
    all[contentHash] = meta
    written = meta
    return all
  })
  if (live && written) live.set(contentHash, written)
}
