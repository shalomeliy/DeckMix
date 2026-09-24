/**
 * Crates (v0.8.1), on `idb-keyval`.
 *
 * Same shape as `track-meta-idb/store.ts`: one key holding `Record<id,
 * CrateRecord>`, a getter that never throws (a missing/blocked IndexedDB must
 * not stop the library from loading, only stop crates from showing up), a
 * setter that throws so the caller (`controls.ts`) can surface a failure
 * instead of an edit that looks saved but silently is not.
 *
 * A manual crate's `members` and a smart crate's `materialized` are both
 * `contentHash[]` — the same identity `genre-overrides`/`track-meta` use, so
 * a crate survives a track turning up in a different genre folder later.
 * `query` is stored verbatim as the exact string `core/library-search.ts`'s
 * `matchesQuery` already knows how to read; there is no new filter format.
 */
import { get, set } from 'idb-keyval'
import type { SearchColumn } from '@/core/library-search'

const KEY = 'deckmix:crates'

export interface CrateRecord {
  id: string
  name: string
  kind: 'manual' | 'smart'
  /** contentHash[], manual crates only. No duplicates — membership is a set, not a list. */
  members?: string[]
  /** The saved search-box query, smart crates only — verbatim, never parsed here. */
  query?: string
  /** v0.8.25: the column the search was limited to when saved ("BPM ▸"), smart crates only. Absent on older crates = the plain search, which is what they always meant. */
  queryColumn?: SearchColumn
  /** contentHash[], smart crates only — the last explicit refresh's result. Never recomputed on render. */
  materialized?: string[]
  /** `Date.now()` of the last refresh, smart crates only — drives the "may be stale" badge. */
  refreshedAt?: number
}

/** All stored crates, `id -> CrateRecord`. Never throws — see file doc comment. */
export async function getCrates(): Promise<Map<string, CrateRecord>> {
  try {
    const stored = await get<Record<string, CrateRecord>>(KEY)
    return new Map(Object.entries(stored ?? {}))
  } catch {
    return new Map()
  }
}

/**
 * Persist one crate, replacing whatever was stored under this id (the
 * caller always hands over the full, already-updated record — there is no
 * partial-field merge here, unlike `track-meta-idb`'s note/lastPlayedAt
 * split, because a crate has no two independent writers racing on the same
 * record). Throws on failure — see file doc comment.
 */
export async function saveCrate(record: CrateRecord): Promise<void> {
  const stored = await get<Record<string, CrateRecord>>(KEY)
  await set(KEY, { ...(stored ?? {}), [record.id]: record })
}

/** Remove one crate by id. Throws on failure — see file doc comment. */
export async function deleteCrateRecord(id: string): Promise<void> {
  const stored = await get<Record<string, CrateRecord>>(KEY)
  if (!stored || !(id in stored)) return
  const { [id]: _removed, ...rest } = stored
  await set(KEY, rest)
}
