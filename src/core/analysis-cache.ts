/**
 * The pure part of `platform/analyze-cache-idb/store.ts`: whether a stored
 * entry is still usable. Kept out of the IndexedDB-touching store itself so
 * this policy is unit-tested without a real IndexedDB — the same split
 * `core/settings.ts`'s `migrate` has from `platform/settings-idb/store.ts`.
 */
import type { TrackAnalysis } from '@/core/ports/analyzer'

export interface StoredAnalysisEntry {
  contentHash: string
  analyzerVersion: number
  analysis: TrackAnalysis
  cachedAt: number
}

/**
 * A cache entry stamped with an older analyzer version is a miss, not a
 * special "stale" state — re-analysis is always safe and idempotent, so
 * there is nothing else to do with a mismatch but treat it as absent. No
 * separate file-size/mtime check: a changed file hashes to a different key
 * by construction (v0.4.0's content-hash identity), so a stale entry under
 * the *same* key would only mean a hash collision.
 */
export function resolveCacheEntry(
  stored: StoredAnalysisEntry | undefined,
  currentVersion: number,
): TrackAnalysis | null {
  if (!stored) return null
  if (stored.analyzerVersion !== currentVersion) return null
  return stored.analysis
}

/**
 * Cache key for an analysis. The tag tempo a grid was refined around is part of
 * what the result means, so the same bytes analysed with a different hint are a
 * different entry, not a stale one.
 */
export function analysisCacheKey(contentHash: string, hintBpm: number | null): string {
  return hintBpm == null ? contentHash : `${contentHash}@${hintBpm}`
}
