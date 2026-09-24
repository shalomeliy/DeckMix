/**
 * FX rack persistence (v0.7.0) — two racks' settings under one key, same
 * `idb-keyval` pattern `sampler-idb/store.ts` already uses. Simpler than the
 * sampler bank: a rack's settings carry no reference to a track (nothing
 * here needs `contentHash` resolution against a re-scanned library), just
 * plain numbers/booleans/strings.
 */
import { get, set } from 'idb-keyval'

const KEY = 'deckmix:fx:racks'

export interface StoredFxRack {
  effect: number
  wetDry: number
  time: number
  on: boolean
  route: 'channel' | 'master'
}

export type StoredFxBank = [StoredFxRack, StoredFxRack]

function isStoredFxRack(v: unknown): v is StoredFxRack {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.effect === 'number' &&
    typeof r.wetDry === 'number' &&
    typeof r.time === 'number' &&
    typeof r.on === 'boolean' &&
    (r.route === 'channel' || r.route === 'master')
  )
}

/** Never throws — a missing/blocked IndexedDB must not stop the app from starting, only leave both racks at their defaults (same choice `sampler-idb`/`mix-ratings-idb` make). */
export async function getFxBank(): Promise<StoredFxBank | null> {
  try {
    const stored = await get<unknown>(KEY)
    if (Array.isArray(stored) && stored.length === 2 && stored.every(isStoredFxRack)) {
      return stored as StoredFxBank
    }
    return null
  } catch {
    return null
  }
}

/** Throws on failure — the one call site in `controls.ts` surfaces it as a notice rather than silently not saving. */
export async function saveFxBank(bank: StoredFxBank): Promise<void> {
  await set(KEY, bank)
}
