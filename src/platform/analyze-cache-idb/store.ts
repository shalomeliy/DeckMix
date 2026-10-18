/**
 * `AnalysisCache` on `idb-keyval`, keyed by content hash (v0.4.0).
 *
 * One IndexedDB record per track, not one shared blob for all of them like
 * `genre-overrides-idb`/`settings-idb` — those hold a handful of entries
 * total, this holds one per track in the library (hundreds), and rewriting a
 * single shared blob on every analysis result would mean every `put` costs
 * O(library size). Per-key storage means one track's cache write never
 * touches another's.
 *
 * The freshness policy itself (`resolveCacheEntry`) is pure and lives in
 * `core/analysis-cache.ts` so it's unit-tested without a real IndexedDB —
 * this file is just the IO wrapper around it.
 */
import { entries as idbEntries, get, set } from 'idb-keyval'
import { resolveCacheEntry, type StoredAnalysisEntry } from '@/core/analysis-cache'
import type { AnalysisCache, TrackAnalysis } from '@/core/ports/analyzer'
import { ANALYZER_VERSION } from '@/platform/analyze-cache-idb/version'

const KEY_PREFIX = 'deckmix:analysisCache:'

class IdbAnalysisCache implements AnalysisCache {
  async get(key: string): Promise<TrackAnalysis | null> {
    let stored: StoredAnalysisEntry | undefined
    try {
      stored = await get<StoredAnalysisEntry>(KEY_PREFIX + key)
    } catch {
      // IndexedDB unavailable (private window, blocked storage): the track
      // just re-analyzes this session, the same degrade every other
      // IDB-backed store in this app already falls back to. Never surfaced
      // as an analysis *failure* — that state means the analysis itself
      // threw, not that its cache couldn't be read.
      return null
    }
    return resolveCacheEntry(stored, ANALYZER_VERSION)
  }

  /**
   * Throws on failure — same choice `genre-overrides-idb` makes — so a
   * caller that cares (the background queue, deck load) can decide how to
   * surface it rather than an edit silently not being remembered.
   */
  async put(key: string, value: TrackAnalysis): Promise<void> {
    const entry: StoredAnalysisEntry = {
      contentHash: key,
      analyzerVersion: ANALYZER_VERSION,
      analysis: value,
      cachedAt: Date.now(),
    }
    await set(KEY_PREFIX + key, entry)
  }
}

export const analysisCache: AnalysisCache = new IdbAnalysisCache()

/**
 * The detected beat grid of every song with a CURRENT-version cached analysis, by content hash (a key may carry a "@tag bpm" hint; the
 * newest entry of a hash wins). Entries from an older analyzer are left out and counted by the caller as "no detection", not guessed from.
 * Throws on a blocked IndexedDB.
 */
export async function getAllDetectedGrids(): Promise<Map<string, { grid: NonNullable<TrackAnalysis['beatGrid']>; durationSec: number; cachedAt: number }>> {
  const out = new Map<string, { grid: NonNullable<TrackAnalysis['beatGrid']>; durationSec: number; cachedAt: number }>()
  for (const [k, v] of await idbEntries<string, StoredAnalysisEntry>()) {
    if (typeof k !== 'string' || !k.startsWith(KEY_PREFIX)) continue
    const analysis = resolveCacheEntry(v, ANALYZER_VERSION)
    if (!analysis?.beatGrid) continue
    const hash = k.slice(KEY_PREFIX.length).split('@')[0]
    const prev = out.get(hash)
    if (!prev || v.cachedAt > prev.cachedAt) out.set(hash, { grid: analysis.beatGrid, durationSec: analysis.durationSec, cachedAt: v.cachedAt })
  }
  return out
}
