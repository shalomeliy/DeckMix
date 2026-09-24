import type { Track } from '@/core/types'

/**
 * Folds a tag-read patch into a track that may already carry analysis
 * results: what the track already holds wins, the tag only fills gaps.
 *
 * "Already holds" means a value, not a key. The analysis merge writes
 * `durationSec: t.durationSec ?? p.durationSec`, which leaves an explicit
 * `durationSec: undefined` on a track whose decode failed. The plain
 * `{ ...patch, ...track }` this replaced let that `undefined` overwrite the
 * tag's TLEN, so when a failed decode landed before the tag pass the Time
 * column went blank for good — two of six tracks in
 * `scripts/verify-library-boot.mjs`, depending on which pass finished first
 * (found 2026-09-24, the first time the verify scripts ran as one suite).
 */
export function mergeTagPatch(track: Track, patch: Partial<Track>): Track {
  const merged: Record<string, unknown> = { ...patch }
  for (const [key, value] of Object.entries(track)) if (value !== undefined) merged[key] = value
  return merged as unknown as Track
}
