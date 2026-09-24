/**
 * Manual genre overrides, on `idb-keyval`.
 *
 * A small dedicated store rather than a `core/ports/persistence.ts` implementation:
 * that port's own doc comment names cue points/loops/the analysis cache as its v0.4
 * consumers, and building it out now would jump ahead of the work it was actually
 * designed for. This mirrors `settings-idb/store.ts`'s shape instead — one key, one
 * plain object, failures caught and reported to the caller rather than swallowed.
 *
 * Two stores, not one (v0.4.0): `KEY` is the original v0.3.2 shape, keyed by
 * `trackId` (a scan-relative path) — nothing writes to it anymore, but it stays
 * as the read-only source `migrate.ts` re-keys from once. `HASH_KEY` is what
 * `controls.ts`'s `setTrackGenre` writes going forward, keyed by content hash so
 * an override survives the file turning up in a different genre folder later —
 * the same identity-unification `analyze-cache-idb`/`cues-idb` use, and the
 * actual fix for the v0.3.2 file-move bug this version closes for genre too.
 */
import { get, set } from 'idb-keyval'

const KEY = 'deckmix:genreOverrides'
const HASH_KEY = 'deckmix:genreOverridesByHash'

/**
 * All stored overrides, `trackId -> genre`, from the original path-keyed
 * store. Returns an empty map (never throws) on a read failure — a missing
 * IndexedDB must not stop the library from loading, only stop overrides from
 * being remembered. Read-only in practice since v0.4.0 — see the file doc
 * comment — kept for `migrate.ts` and for `Library.tsx`'s scan-time pass,
 * which still applies it directly for the common "file hasn't moved" case
 * before any content hash exists to look up.
 */
export async function getGenreOverrides(): Promise<Map<string, string>> {
  try {
    const stored = await get<Record<string, string>>(KEY)
    return new Map(Object.entries(stored ?? {}))
  } catch {
    return new Map()
  }
}

/** All stored overrides, `contentHash -> genre` (v0.4.0). Same never-throws contract as above. */
export async function getGenreOverridesByHash(): Promise<Map<string, string>> {
  try {
    const stored = await get<Record<string, string>>(HASH_KEY)
    return new Map(Object.entries(stored ?? {}))
  } catch {
    return new Map()
  }
}

/**
 * Persist one override, keyed by content hash. Throws on failure so the
 * caller — `controls.ts`, the one place user actions are dispatched from —
 * can decide how to surface it; swallowing it here would mean an edit that
 * looks saved but silently is not.
 */
export async function setGenreOverrideByHash(contentHash: string, genre: string): Promise<void> {
  const stored = await get<Record<string, string>>(HASH_KEY)
  await set(HASH_KEY, { ...(stored ?? {}), [contentHash]: genre })
}
