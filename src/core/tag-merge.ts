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
  // The one exception to "what the track holds wins" (v0.8.27): a key the
  // analysis detected is a guess, a key tag is the owner's own data. The
  // analysis pass runs alongside this one, so either can land first.
  if (track.keySource === 'detected' && (patch.key || patch.camelot)) {
    merged.key = patch.key
    merged.camelot = patch.camelot
    delete merged.keySource
    delete merged.keyUncertain
  }
  return merged as unknown as Track
}

/**
 * The analysis side of the same rule: a detected key fills a track only when
 * it has no key at all. A tag that is present — even one in a spelling
 * `parseKey` could not read, kept as bare `key` — is never replaced.
 */
export function fillDetectedKey(track: Track, detected: Partial<Track>): Track {
  if (!detected.keySource || track.key || track.camelot) return track
  return { ...track, key: detected.key, camelot: detected.camelot, keySource: 'detected', keyUncertain: detected.keyUncertain }
}

/**
 * The background queue's merge (`Library.tsx`): tag values already on the
 * track win for bpm/duration, and the key fields go through
 * `fillDetectedKey`, never the spread — a plain `{ ...t, ...p }` would put a
 * detected key on top of a tag the tag pass read first.
 */
export function mergeAnalysisPatch(track: Track, patch: Partial<Track>): Track {
  const { key: _key, camelot: _camelot, keySource: _source, keyUncertain: _uncertain, ...rest } = patch
  return fillDetectedKey(
    { ...track, ...rest, bpm: track.bpm ?? patch.bpm, durationSec: track.durationSec ?? patch.durationSec },
    patch,
  )
}

/**
 * A deck holds a snapshot of the track from load time; the tag pass only
 * updates the library. So before a detected key goes on a deck, take the key
 * the library holds *now* — otherwise a tag read during the deck's analysis
 * loses to the guess (found in review, v0.8.27).
 */
export function withLatestKey(track: Track, latest: Track | undefined): Track {
  if (!latest || (!latest.key && !latest.camelot)) return track
  return { ...track, key: latest.key, camelot: latest.camelot, keySource: latest.keySource, keyUncertain: latest.keyUncertain }
}
